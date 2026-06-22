import { getDb } from "./database.js";

// ─── クリップボード / 一時メモ（§3.10） ──────────────────────────────────────
// 「今日・今だけ覚えておいてほしい」揮発的なメモ。TTL付きで自動削除される。

export interface ClipboardEntry {
	id: number;
	user_id: string;
	bot_id: string;
	content: string;
	expires_at: string | null; // 'YYYY-MM-DD HH:MM:SS'（ローカルタイム）。NULL = 無期限
	created_at: string;
}

/**
 * クリップボードエントリを追加する
 * @param expiresAt 'YYYY-MM-DD HH:MM:SS' 形式。null = 無期限
 */
export function addEntry(
	userId: string,
	botId: string,
	content: string,
	expiresAt: string | null,
): ClipboardEntry {
	const db = getDb();
	const result = db
		.prepare(
			"INSERT INTO clipboard_entries (user_id, bot_id, content, expires_at) VALUES (?, ?, ?, ?)",
		)
		.run(userId, botId, content, expiresAt);
	return db
		.prepare("SELECT * FROM clipboard_entries WHERE id = ?")
		.get(result.lastInsertRowid) as ClipboardEntry;
}

/** 有効な（期限切れでない）エントリ一覧を取得する */
export function listEntries(userId: string, botId: string): ClipboardEntry[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM clipboard_entries
       WHERE user_id = ? AND bot_id = ?
         AND (expires_at IS NULL OR expires_at > datetime('now', 'localtime'))
       ORDER BY created_at DESC`,
		)
		.all(userId, botId) as ClipboardEntry[];
}

export function deleteEntry(
	userId: string,
	botId: string,
	id: number,
): boolean {
	const db = getDb();
	const result = db
		.prepare(
			"DELETE FROM clipboard_entries WHERE user_id = ? AND bot_id = ? AND id = ?",
		)
		.run(userId, botId, id);
	return result.changes > 0;
}

/**
 * 期限切れエントリの一括削除（cron用・全ユーザー横断走査。
 * TTL自動削除という機能特性上 user_id 条件を持たない例外クエリ §3.10.3）
 * @returns 削除件数
 */
export function deleteExpired(): number {
	const db = getDb();
	const result = db
		.prepare(
			"DELETE FROM clipboard_entries WHERE expires_at IS NOT NULL AND expires_at <= datetime('now', 'localtime')",
		)
		.run();
	return result.changes;
}
