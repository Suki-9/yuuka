import { getDb } from "./database.js";
import { getRedisClient } from "./redis.js";

export interface ChatHistoryEntry {
  role: "user" | "model";
  text: string;
}

/**
 * チャット履歴に新しいメッセージを追加する
 */
export async function addChatMessage(botId: string, role: "user" | "model", text: string): Promise<void> {
  // 1. SQLite に永続化保存
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO chat_history (bot_id, role, text)
      VALUES (?, ?, ?)
    `);
    stmt.run(botId, role, text);
  } catch (err) {
    console.error("❌ SQLite へのメッセージ保存に失敗しました:", err);
    throw err;
  }

  // 2. Redis キャッシュへ保存
  const redis = getRedisClient();
  if (redis) {
    const key = `yuuka:chat_history:${botId}`;
    const entry = JSON.stringify({ role, text });
    try {
      // リストの末尾に追加
      await redis.rPush(key, entry);
      // 直近 30 件のみに維持し、メモリ肥大化を抑える
      await redis.lTrim(key, -30, -1);
    } catch (err) {
      console.error("⚠️ Redis キャッシュへの書き込みに失敗しました (SQLiteにのみ保存されます):", err);
    }
  }
}

/**
 * 直近のチャット履歴を取得する（古い順）
 */
export async function getRecentChatHistory(botId: string, limit: number = 20): Promise<ChatHistoryEntry[]> {
  const key = `yuuka:chat_history:${botId}`;
  const redis = getRedisClient();

  // 1. Redis キャッシュからの読み出しを試みる
  if (redis) {
    try {
      const cachedList = await redis.lRange(key, 0, -1);
      if (cachedList && cachedList.length > 0) {
        const parsed = cachedList.map(item => JSON.parse(item) as ChatHistoryEntry);
        // 末尾（最新）から limit 件分を取得
        return parsed.slice(-limit);
      }
    } catch (err) {
      console.error("⚠️ Redis キャッシュからの読み込みに失敗しました。SQLite から読み出します。:", err);
    }
  }

  // 2. キャッシュミスまたは Redis 無効時の SQLite からの読み出しフォールバック
  const db = getDb();
  const stmt = db.prepare(`
    SELECT role, text FROM (
      SELECT role, text, id FROM chat_history
      WHERE bot_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `);
  
  const rows = stmt.all(botId, limit) as { role: string; text: string }[];
  const history = rows.map((row) => ({
    role: row.role as "user" | "model",
    text: row.text,
  }));

  // 3. 取得した履歴を Redis キャッシュに再構築 (非同期で実行)
  if (redis && history.length > 0) {
    try {
      const jsonStrings = history.map(item => JSON.stringify(item));
      // キャッシュキーを一度削除して再構築
      await redis.del(key);
      await redis.rPush(key, jsonStrings);
      await redis.lTrim(key, -30, -1);
    } catch (err) {
      console.error("⚠️ Redis キャッシュの再構築に失敗しました:", err);
    }
  }

  return history;
}

/**
 * 特定のユーザーのチャット履歴をクリアする
 */
export async function clearChatHistory(botId: string): Promise<void> {
  // 1. SQLite から削除
  try {
    const db = getDb();
    const stmt = db.prepare(`
      DELETE FROM chat_history WHERE bot_id = ?
    `);
    stmt.run(botId);
  } catch (err) {
    console.error("❌ SQLite の履歴削除に失敗しました:", err);
    throw err;
  }

  // 2. Redis キャッシュを削除
  const redis = getRedisClient();
  if (redis) {
    const key = `yuuka:chat_history:${botId}`;
    try {
      await redis.del(key);
    } catch (err) {
      console.error("⚠️ Redis キャッシュの削除に失敗しました:", err);
    }
  }
}
