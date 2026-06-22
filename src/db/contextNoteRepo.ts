import { getDb } from "./database.js";

// ─── コンテキストノート（§3.7） ──────────────────────────────────────────────
// ユーザーが「覚えておいてほしい事柄」の永続メモ。ユーザーにつき1ドキュメント。
// システムプロンプトの末尾（ペルソナの後）に注入される。

/** 上限文字数（§3.7.2: ペルソナと合算でコンテキストを圧迫しないよう制限） */
export const CONTEXT_NOTE_MAX_LENGTH = 10000;

/** コンテキストノート全文を取得する（未登録なら空文字） */
export function getContextNote(userId: string, botId: string): string {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT content FROM context_notes WHERE user_id = ? AND bot_id = ?",
		)
		.get(userId, botId) as { content: string } | undefined;
	return row?.content ?? "";
}

export function getContextNoteUpdatedAt(
	userId: string,
	botId: string,
): string | null {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT updated_at FROM context_notes WHERE user_id = ? AND bot_id = ?",
		)
		.get(userId, botId) as { updated_at: string } | undefined;
	return row?.updated_at ?? null;
}

/**
 * コンテキストノートを全文置換する（10,000文字超はエラー）
 */
export function setContextNote(
	userId: string,
	botId: string,
	content: string,
): void {
	if (content.length > CONTEXT_NOTE_MAX_LENGTH) {
		throw new Error(
			`コンテキストノートは${CONTEXT_NOTE_MAX_LENGTH.toLocaleString()}文字以内です（現在: ${content.length.toLocaleString()}文字）`,
		);
	}
	const db = getDb();
	db.prepare(
		`INSERT INTO context_notes (user_id, bot_id, content, updated_at)
     VALUES (?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(user_id, bot_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now', 'localtime')`,
	).run(userId, botId, content);
}

/**
 * コンテキストノートへ1行追記する（改行区切り。上限超過時はエラー）
 * @returns 追記後の全文
 */
export function appendContextNote(
	userId: string,
	botId: string,
	line: string,
): string {
	const trimmed = line.trim();
	if (!trimmed) {
		throw new Error("追記する内容が空です");
	}
	const current = getContextNote(userId, botId);
	const next = current ? `${current}\n${trimmed}` : trimmed;
	if (next.length > CONTEXT_NOTE_MAX_LENGTH) {
		throw new Error(
			`コンテキストノートの上限（${CONTEXT_NOTE_MAX_LENGTH.toLocaleString()}文字）を超えるため追記できません。` +
				`不要な項目を整理してから追記してください（現在: ${current.length.toLocaleString()}文字）`,
		);
	}
	setContextNote(userId, botId, next);
	return next;
}
