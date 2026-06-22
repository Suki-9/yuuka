import { getDb } from "./database.js";

// ─── シナプス（記憶の断片）リポジトリ ─────────────────────────────────────────
//
// synapses テーブル（スキーマ定義は db/migrations.ts が唯一の定義元）のリポジトリ。
// 会話から抽出した記憶の断片を1件ずつ保存し、埋め込みベクトル（embedding BLOB）を
// 後追いで埋める。想起時は decay_score / use_count で鮮度を管理する。
// データ分離の原則: スコープ付きクエリは user_id + bot_id を WHERE 必須条件とする
// （id 主キー指定の touch/get/delete は assemble 側で既にスコープ済みの id を受け取る前提）。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

/** シナプスの所属スコープ（guild_id = NULL は DM・秘書利用） */
export interface SynapseScope {
	userId: string;
	botId: string;
	guildId?: string | null;
}

/**
 * synapses テーブルの1レコード（embedding BLOB は含まない）。
 * 想起時に生バイト列は不要なため、SELECT 対象から embedding を除く。
 */
export interface SynapseRecord {
	id: number;
	user_id: string;
	bot_id: string;
	guild_id: string | null;
	content: string;
	topic_id: string | null;
	source_msg_id: number | null;
	embedding_model_version: string | null;
	created_at: string;
	last_used_at: string | null;
	use_count: number;
	decay_score: number;
}

/** SELECT で取得するカラム（embedding BLOB を除いた SynapseRecord の全列） */
const RECORD_COLUMNS = `id, user_id, bot_id, guild_id, content, topic_id, source_msg_id,
  embedding_model_version, created_at, last_used_at, use_count, decay_score`;

// ─── 追加・更新 ──────────────────────────────────────────────────────────────

/** シナプス（記憶の断片）を1件挿入し、生成された id を返す。embedding は後から updateEmbedding で埋める。 */
export function insertSynapse(args: {
	scope: SynapseScope;
	content: string;
	topicId?: string | null;
	sourceMsgId?: number | null;
	/** 形成時の時間帯（0-23）。再ランキング専用。未指定は NULL（文脈未知）。 */
	ctxTod?: number | null;
	/** 形成時の曜日（0=日〜6=土）。再ランキング専用。未指定は NULL（文脈未知）。 */
	ctxDow?: number | null;
}): number {
	const db = getDb();
	const info = db
		.prepare(
			`INSERT INTO synapses (user_id, bot_id, guild_id, content, topic_id, source_msg_id, ctx_tod, ctx_dow)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			args.scope.userId,
			args.scope.botId,
			args.scope.guildId ?? null,
			args.content,
			args.topicId ?? null,
			args.sourceMsgId ?? null,
			args.ctxTod ?? null,
			args.ctxDow ?? null,
		);
	return Number(info.lastInsertRowid);
}

/**
 * 埋め込みベクトル（生 BLOB バイト列）とモデル世代を保存する。
 * Rust エンジンが返した base64 を呼び出し側がデコードして Buffer で渡す
 * （better-sqlite3 は Node Buffer をそのまま BLOB としてバインドする）。
 */
export function updateSynapseEmbedding(
	id: number,
	embedding: Buffer,
	modelVersion: string,
): void {
	const db = getDb();
	db.prepare(
		`UPDATE synapses SET embedding = ?, embedding_model_version = ? WHERE id = ?`,
	).run(embedding, modelVersion, id);
}

/**
 * 想起されたシナプスの鮮度を更新する（use_count++ / last_used_at=now / decay_score を加点）。
 * ※ ここで渡される id 群はスコープ済みの assemble（user_id + bot_id で絞り込み済み）から
 *   得られたものを前提とするため、主キー id でのみ更新する。
 */
export function touchSynapses(ids: number[]): void {
	if (ids.length === 0) return;
	const db = getDb();
	const placeholders = ids.map(() => "?").join(", ");
	db.prepare(
		`UPDATE synapses SET
       use_count = use_count + 1,
       last_used_at = datetime('now', 'localtime'),
       decay_score = decay_score + 1.0
     WHERE id IN (${placeholders})`,
	).run(...ids);
}

// ─── 取得・集計・削除 ────────────────────────────────────────────────────────

/**
 * id 配列でシナプスを取得（存在するものだけ。順序は問わない）。
 * embedding BLOB は含めず、SynapseRecord のカラムのみ返す。
 */
export function getSynapsesByIds(ids: number[]): SynapseRecord[] {
	if (ids.length === 0) return [];
	const db = getDb();
	const placeholders = ids.map(() => "?").join(", ");
	return db
		.prepare(
			`SELECT ${RECORD_COLUMNS} FROM synapses WHERE id IN (${placeholders})`,
		)
		.all(...ids) as SynapseRecord[];
}

/** スコープ内のシナプス件数（計測・上限管理用） */
export function countSynapses(scope: SynapseScope): number {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT COUNT(*) AS cnt FROM synapses WHERE user_id = ? AND bot_id = ?",
		)
		.get(scope.userId, scope.botId) as { cnt: number };
	return row.cnt;
}

/** シナプスを削除する（id 指定）。戻り値は削除件数。 */
export function deleteSynapse(id: number): number {
	const db = getDb();
	const result = db.prepare("DELETE FROM synapses WHERE id = ?").run(id);
	return result.changes;
}
