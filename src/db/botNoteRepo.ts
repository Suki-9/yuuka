import { getDb } from "./database.js";

// ─── 汎用モードのコンテキストノート（bot_attributes_requirements.md §4.6.2） ──
// 個人ノート: bot_id × ユーザー単位（bot_context_notes）。本人の会話からのみ書き込まれ、
//             他メンバーのプロンプトには注入しない。
// 共有ノート: bot_id × ギルド単位（bot_guild_notes）。利用メンバー全員が参照・編集できる。
// 秘書用の context_notes（user_id 単位）とは別テーブルで現状維持。

/** 上限文字数（context_notes と同じ 10,000 文字。要件 §5） */
export const BOT_NOTE_MAX_LENGTH = 10000;

function validateLength(content: string, label: string): void {
	if (content.length > BOT_NOTE_MAX_LENGTH) {
		throw new Error(
			`${label}は${BOT_NOTE_MAX_LENGTH.toLocaleString()}文字以内です（現在: ${content.length.toLocaleString()}文字）`,
		);
	}
}

// ─── 個人ノート（bot_id × user_id） ──────────────────────────────────────────

export function getBotUserNote(botId: string, userId: string): string {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT content FROM bot_context_notes WHERE bot_id = ? AND user_id = ?",
		)
		.get(botId, userId) as { content: string } | undefined;
	return row?.content ?? "";
}

export function setBotUserNote(
	botId: string,
	userId: string,
	content: string,
): void {
	validateLength(content, "個人ノート");
	const db = getDb();
	db.prepare(
		`INSERT INTO bot_context_notes (bot_id, user_id, content, updated_at)
     VALUES (?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(bot_id, user_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now', 'localtime')`,
	).run(botId, userId, content);
}

/** 個人ノートへ1行追記する（上限超過時はエラー）。@returns 追記後の全文 */
export function appendBotUserNote(
	botId: string,
	userId: string,
	line: string,
): string {
	const trimmed = line.trim();
	if (!trimmed) throw new Error("追記する内容が空です");
	const current = getBotUserNote(botId, userId);
	const next = current ? `${current}\n${trimmed}` : trimmed;
	validateLength(next, "個人ノート");
	setBotUserNote(botId, userId, next);
	return next;
}

export function deleteBotUserNote(botId: string, userId: string): boolean {
	const db = getDb();
	return (
		db
			.prepare("DELETE FROM bot_context_notes WHERE bot_id = ? AND user_id = ?")
			.run(botId, userId).changes > 0
	);
}

// ─── 共有ノート（bot_id × guild_id） ─────────────────────────────────────────

export function getBotGuildNote(botId: string, guildId: string): string {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT content FROM bot_guild_notes WHERE bot_id = ? AND guild_id = ?",
		)
		.get(botId, guildId) as { content: string } | undefined;
	return row?.content ?? "";
}

export function setBotGuildNote(
	botId: string,
	guildId: string,
	content: string,
): void {
	validateLength(content, "共有ノート");
	const db = getDb();
	db.prepare(
		`INSERT INTO bot_guild_notes (bot_id, guild_id, content, updated_at)
     VALUES (?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(bot_id, guild_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now', 'localtime')`,
	).run(botId, guildId, content);
}

/** 共有ノートへ1行追記する（上限超過時はエラー）。@returns 追記後の全文 */
export function appendBotGuildNote(
	botId: string,
	guildId: string,
	line: string,
): string {
	const trimmed = line.trim();
	if (!trimmed) throw new Error("追記する内容が空です");
	const current = getBotGuildNote(botId, guildId);
	const next = current ? `${current}\n${trimmed}` : trimmed;
	validateLength(next, "共有ノート");
	setBotGuildNote(botId, guildId, next);
	return next;
}
