import { isBotMember } from "./botAttributesRepo.js";
import { getDb } from "./database.js";

// ─── ギルド利用メンバーの利用申請（bot_member_requests） ──────────────────────
// Discordユーザーが (bot_id, guild_id) 単位で利用を申請し、Botオーナーが承認/却下する。
// 重複防止: 既にメンバーなら申請不可、pending申請が既存なら二重申請にしない（UNIQUE制約 + 明示チェック）。
// 認可（owner検証等）は呼び出し側で行う。

export type MemberRequestStatus = "pending" | "approved" | "rejected";

export interface BotMemberRequestRecord {
	id: number;
	bot_id: string;
	guild_id: string;
	user_id: string;
	status: MemberRequestStatus;
	note: string | null;
	decided_by: string | null;
	created_at: string;
	updated_at: string;
}

export type CreateRequestResult =
	| { ok: true; request: BotMemberRequestRecord; duplicate: false }
	| { ok: false; reason: "already_member" | "already_pending" };

/**
 * 利用申請を作成する。
 * - 既に利用メンバーなら作成しない（already_member）。
 * - 同一 (bot, guild, user) の pending 申請が既にあれば二重申請にしない（already_pending）。
 * - 過去に却下/承認済みの申請レコードがある場合は status を pending に戻して再申請とする。
 */
export function createMemberRequest(
	botId: string,
	guildId: string,
	userId: string,
	note?: string,
): CreateRequestResult {
	const db = getDb();

	if (isBotMember(botId, guildId, userId)) {
		return { ok: false, reason: "already_member" };
	}

	const existing = db
		.prepare(
			"SELECT * FROM bot_member_requests WHERE bot_id = ? AND guild_id = ? AND user_id = ?",
		)
		.get(botId, guildId, userId) as BotMemberRequestRecord | undefined;

	if (existing?.status === "pending") {
		return { ok: false, reason: "already_pending" };
	}

	const trimmedNote = note?.trim() ? note.trim().slice(0, 500) : null;

	if (existing) {
		// 過去に却下/承認された申請レコードを pending として再利用する
		db.prepare(
			`UPDATE bot_member_requests
       SET status = 'pending', note = ?, decided_by = NULL,
           updated_at = datetime('now','localtime')
       WHERE id = ?`,
		).run(trimmedNote, existing.id);
		return {
			ok: true,
			request: getMemberRequestById(existing.id)!,
			duplicate: false,
		};
	}

	const info = db
		.prepare(
			`INSERT INTO bot_member_requests (bot_id, guild_id, user_id, note)
       VALUES (?, ?, ?, ?)`,
		)
		.run(botId, guildId, userId, trimmedNote);
	return {
		ok: true,
		request: getMemberRequestById(Number(info.lastInsertRowid))!,
		duplicate: false,
	};
}

export function getMemberRequestById(
	id: number,
): BotMemberRequestRecord | undefined {
	const db = getDb();
	return db.prepare("SELECT * FROM bot_member_requests WHERE id = ?").get(id) as
		| BotMemberRequestRecord
		| undefined;
}

/** 指定Botの申請一覧（owner用。status指定で絞り込み） */
export function listMemberRequestsForBot(
	botId: string,
	status?: MemberRequestStatus,
): BotMemberRequestRecord[] {
	const db = getDb();
	if (status) {
		return db
			.prepare(
				"SELECT * FROM bot_member_requests WHERE bot_id = ? AND status = ? ORDER BY created_at DESC",
			)
			.all(botId, status) as BotMemberRequestRecord[];
	}
	return db
		.prepare(
			"SELECT * FROM bot_member_requests WHERE bot_id = ? ORDER BY created_at DESC",
		)
		.all(botId) as BotMemberRequestRecord[];
}

/** 申請者本人の申請状況一覧（マイページ用） */
export function listMemberRequestsByUser(
	userId: string,
): BotMemberRequestRecord[] {
	const db = getDb();
	return db
		.prepare(
			"SELECT * FROM bot_member_requests WHERE user_id = ? ORDER BY created_at DESC",
		)
		.all(userId) as BotMemberRequestRecord[];
}

/**
 * 申請を承認/却下する（pending のもののみ遷移可能）。
 * @returns 状態遷移できたら true（既に処理済み・不存在なら false）
 */
export function decideMemberRequest(
	id: number,
	status: "approved" | "rejected",
	decidedBy: string,
): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bot_member_requests
         SET status = ?, decided_by = ?, updated_at = datetime('now','localtime')
         WHERE id = ? AND status = 'pending'`,
			)
			.run(status, decidedBy, id).changes > 0
	);
}
