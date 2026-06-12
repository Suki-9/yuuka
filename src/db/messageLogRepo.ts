import { getDb } from "./database.js";
import { getRedisClient } from "./redis.js";
import { getSystemSetting, setSystemSetting } from "./systemSettingsRepo.js";
import { config } from "../config.js";

// ─── 会話履歴の永続化（§7）+ コンテキストキャッシュ（§3.1.4）+ 全文検索（§3.12） ─
//
// 正の履歴は SQLite (message_logs) が保持し、Redis (context:{userId}) は
// LLM へ受け渡す直近15件の高速キャッシュとして二重書き込みする。
// Redis キャッシュ消失時は SQLite から直近15件を再構築する。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface MessageLogRecord {
  id: number;
  user_id: string;
  bot_id: string;
  discord_msg_id: string | null;
  role: "user" | "assistant";
  content: string;
  reply_to_msg_id: string | null;
  created_at: string;
}

/** LLMへ受け渡す会話コンテキストの1エントリ */
export interface ContextEntry {
  role: "user" | "assistant";
  content: string;
}

/** searchMessages の検索条件 */
export interface MessageSearchOptions {
  /** 全文検索キーワード（省略時は期間のみで検索） */
  keyword?: string;
  /** 検索開始日時（ISO日付 'YYYY-MM-DD' または 'YYYY-MM-DD HH:MM:SS'） */
  from?: string;
  /** 検索終了日時（日付のみ指定時はその日の終わりまで含む） */
  to?: string;
  /** 最大取得件数（デフォルト10件） */
  limit?: number;
}

// ─── 定数 ────────────────────────────────────────────────────────────────────

/** Redisコンテキストキャッシュの保持件数（§3.1.4: 直近15件） */
const CONTEXT_LIMIT = 15;

/** Redisコンテキストキャッシュの TTL（§3.1.4: セッション有効期限7日に連動） */
const CONTEXT_TTL_SECONDS = config.sessionTtlDays * 24 * 60 * 60;

/** Redisコンテキストキャッシュのキー（§3.1.4: context:{discord_user_id}） */
function contextKey(userId: string): string {
  return `context:${userId}`;
}

/**
 * コンテキストリセット境界の system_settings キー。
 * clearContext 実行時点の最大 message_logs.id を記録し、
 * Redisキャッシュ再構築時にそれ以前のメッセージを復元しないようにする
 * （SQLiteの永続ログ自体は §7.1 に従い削除しない）。
 */
function contextFloorKey(userId: string): string {
  return `context_floor:${userId}`;
}

/** コンテキストリセット境界（これより小さい id はコンテキスト再構築に使わない） */
function getContextFloor(userId: string): number {
  const value = getSystemSetting(contextFloorKey(userId), "0");
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ─── 書き込み ────────────────────────────────────────────────────────────────

/**
 * 送受信メッセージを記録する（§7.1: 送信と同時にSQLiteへ永続保存）。
 * SQLite への永続化と Redis コンテキストキャッシュへの二重書き込みを行う。
 * Redis 書き込みの失敗は警告に留め、SQLite 保存が成功していればエラーにしない。
 */
export async function addMessageLog(
  userId: string,
  botId: string,
  role: "user" | "assistant",
  content: string,
  discordMsgId?: string,
  replyToMsgId?: string
): Promise<void> {
  // 1. SQLite へ永続化（正の履歴）
  const db = getDb();
  db.prepare(
    `INSERT INTO message_logs (user_id, bot_id, discord_msg_id, role, content, reply_to_msg_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, botId, discordMsgId ?? null, role, content, replyToMsgId ?? null);

  // 2. Redis コンテキストキャッシュへ追記（末尾が最新、直近15件のみ保持、TTLリセット）
  const redis = getRedisClient();
  if (redis) {
    const key = contextKey(userId);
    try {
      const entry: ContextEntry = { role, content };
      await redis.rPush(key, JSON.stringify(entry));
      await redis.lTrim(key, -CONTEXT_LIMIT, -1);
      await redis.expire(key, CONTEXT_TTL_SECONDS);
    } catch (err) {
      console.error("⚠️ Redis コンテキストキャッシュへの書き込みに失敗しました (SQLiteには保存済み):", err);
    }
  }
}

// ─── コンテキスト取得・再構築（§3.1.4） ─────────────────────────────────────

/**
 * LLMへ渡す直近の会話コンテキストを取得する（古い順）。
 * Redis キャッシュを優先し、キャッシュが無ければ SQLite から直近 limit 件で再構築する。
 */
export async function getRecentContext(
  userId: string,
  limit: number = CONTEXT_LIMIT
): Promise<ContextEntry[]> {
  const key = contextKey(userId);
  const redis = getRedisClient();

  // 1. Redis キャッシュからの読み出しを試みる
  if (redis) {
    try {
      const cached = await redis.lRange(key, 0, -1);
      if (cached && cached.length > 0) {
        // アクセスに合わせて TTL をリセット（セッション有効期限に連動）
        await redis.expire(key, CONTEXT_TTL_SECONDS);
        const parsed = cached.map((item) => JSON.parse(item) as ContextEntry);
        return parsed.slice(-limit);
      }
    } catch (err) {
      console.error("⚠️ Redis コンテキストの読み込みに失敗しました。SQLite から再構築します。:", err);
    }
  }

  // 2. キャッシュミス時: SQLite から直近 limit 件で再構築（リセット境界より後のみ）
  const db = getDb();
  const floor = getContextFloor(userId);
  const rows = db
    .prepare(
      `SELECT role, content FROM (
         SELECT id, role, content FROM message_logs
         WHERE user_id = ? AND id > ?
         ORDER BY id DESC
         LIMIT ?
       ) ORDER BY id ASC`
    )
    .all(userId, floor, limit) as { role: string; content: string }[];

  const history: ContextEntry[] = rows.map((row) => ({
    role: row.role as "user" | "assistant",
    content: row.content,
  }));

  // 3. 取得した履歴で Redis キャッシュを再構築
  if (redis && history.length > 0) {
    try {
      await redis.del(key);
      await redis.rPush(key, history.map((item) => JSON.stringify(item)));
      await redis.lTrim(key, -CONTEXT_LIMIT, -1);
      await redis.expire(key, CONTEXT_TTL_SECONDS);
    } catch (err) {
      console.error("⚠️ Redis コンテキストキャッシュの再構築に失敗しました:", err);
    }
  }

  return history;
}

/**
 * ユーザーの会話コンテキストをリセットする。
 * Redis キャッシュを削除し、リセット境界（現在の最大id）を記録することで
 * 以降の SQLite 再構築でも過去メッセージを復元しないようにする。
 * 永続ログ (message_logs) 自体は削除しない（§7.1: 件数・期間の制限なし。検索 §3.12 でも利用）。
 */
export async function clearContext(userId: string): Promise<void> {
  // 1. リセット境界を記録（SQLite からの再構築を防ぐ）
  const db = getDb();
  const row = db
    .prepare("SELECT MAX(id) AS max_id FROM message_logs WHERE user_id = ?")
    .get(userId) as { max_id: number | null };
  if (row.max_id !== null) {
    setSystemSetting(contextFloorKey(userId), String(row.max_id));
  }

  // 2. Redis キャッシュを削除
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.del(contextKey(userId));
    } catch (err) {
      console.error("⚠️ Redis コンテキストキャッシュの削除に失敗しました:", err);
    }
  }
}

// ─── 返信チェーン解決（§7.3） ────────────────────────────────────────────────

/**
 * DiscordメッセージIDから保存済みメッセージを1件取得する。
 * 注意: DiscordメッセージIDはグローバル一意（Snowflake）だが、
 * 呼び出し側は取得結果の user_id が要求ユーザーと一致するか必ず確認すること（データ分離）。
 */
export function getMessageByDiscordId(discordMsgId: string): MessageLogRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM message_logs WHERE discord_msg_id = ? ORDER BY id DESC LIMIT 1")
    .get(discordMsgId) as MessageLogRecord | undefined;
}

/**
 * 返信チェーンを再帰的に遡って解決する（§7.3）。
 * reply_to_msg_id を辿り、ルートメッセージ（reply_to_msg_id = NULL）または
 * 上限深度 maxDepth（デフォルト: config.replyChainMaxDepth）に達した時点で停止する。
 * 戻り値は古い順（ルート→直近の返信元）。本人の user_id に一致するメッセージのみ辿る。
 */
export function resolveReplyChain(
  userId: string,
  replyToMsgId: string,
  maxDepth: number = config.replyChainMaxDepth
): MessageLogRecord[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM message_logs WHERE discord_msg_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1"
  );

  const chain: MessageLogRecord[] = [];
  const visited = new Set<string>(); // 循環参照による無限ループ防止
  let currentMsgId: string | null = replyToMsgId;

  while (currentMsgId && chain.length < maxDepth) {
    if (visited.has(currentMsgId)) break;
    visited.add(currentMsgId);

    const record = stmt.get(currentMsgId, userId) as MessageLogRecord | undefined;
    if (!record) break; // ログに無いメッセージ（Bot導入前・他ユーザー等）に達したら停止

    chain.unshift(record); // 古い順に並べる
    currentMsgId = record.reply_to_msg_id;
  }

  return chain;
}

// ─── 全文検索（§3.12: FTS5 trigram） ─────────────────────────────────────────

/**
 * 期間指定を created_at の保存形式 'YYYY-MM-DD HH:MM:SS' に正規化する。
 * 日付のみ指定の場合、終了側はその日の終わり（23:59:59）まで含める。
 */
function normalizePeriod(value: string, isEnd: boolean): string {
  const v = value.trim().replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return isEnd ? `${v} 23:59:59` : `${v} 00:00:00`;
  }
  return v;
}

/**
 * 過去の会話履歴を全文検索する（§3.12）。
 * プライバシー配慮（§3.12.3）: 本人の user_id を必須条件とし、他ユーザーの会話は対象外。
 * - keyword あり（3文字以上）: FTS5 (trigramトークナイザ) の MATCH で高速検索
 * - keyword あり（3文字未満）: trigram は3文字未満を索引できないため LIKE にフォールバック
 * - keyword なし: 期間のみで検索
 * 戻り値は新しい順。
 */
export function searchMessages(
  userId: string,
  options: MessageSearchOptions
): MessageLogRecord[] {
  const db = getDb();
  const { keyword, from, to } = options;
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), 100);

  // 期間条件（created_at 範囲）を組み立てる
  const periodConds: string[] = [];
  const periodParams: string[] = [];
  if (from) {
    periodConds.push("m.created_at >= ?");
    periodParams.push(normalizePeriod(from, false));
  }
  if (to) {
    periodConds.push("m.created_at <= ?");
    periodParams.push(normalizePeriod(to, true));
  }
  const periodSql = periodConds.length > 0 ? ` AND ${periodConds.join(" AND ")}` : "";

  const trimmedKeyword = keyword?.trim();

  if (trimmedKeyword && Array.from(trimmedKeyword).length >= 3) {
    // FTS5 MATCH 構文のエスケープ: ダブルクォートで囲み、内部の " は "" に二重化
    // （ユーザー入力を演算子として解釈させない）
    const matchExpr = `"${trimmedKeyword.replace(/"/g, '""')}"`;
    return db
      .prepare(
        `SELECT m.* FROM message_logs_fts
         JOIN message_logs m ON m.id = message_logs_fts.rowid
         WHERE message_logs_fts MATCH ? AND m.user_id = ?${periodSql}
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(matchExpr, userId, ...periodParams, limit) as MessageLogRecord[];
  }

  if (trimmedKeyword) {
    // trigram トークナイザは3文字未満の部分一致を検索できないため LIKE で代替
    const likePattern = `%${trimmedKeyword.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    return db
      .prepare(
        `SELECT m.* FROM message_logs m
         WHERE m.user_id = ? AND m.content LIKE ? ESCAPE '\\'${periodSql}
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(userId, likePattern, ...periodParams, limit) as MessageLogRecord[];
  }

  // keyword 省略時: 期間のみで検索
  return db
    .prepare(
      `SELECT m.* FROM message_logs m
       WHERE m.user_id = ?${periodSql}
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(userId, ...periodParams, limit) as MessageLogRecord[];
}

/** ユーザーの保存済みメッセージ総数を返す（統計・レポート用） */
export function countMessages(userId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM message_logs WHERE user_id = ?")
    .get(userId) as { cnt: number };
  return row.cnt;
}
