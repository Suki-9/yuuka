import { sendMemberDecisionDM, sendMemberRequestDM } from "../bot.js";
import { addBotMember } from "../db/botAttributesRepo.js";
import {
	createMemberRequest,
	decideMemberRequest,
	getMemberRequestById,
} from "../db/botMemberRequestRepo.js";
import { getBotById } from "../db/botRepo.js";
import { isAdmin } from "../db/userRepo.js";

// ─── ギルド利用メンバーの利用申請サービス（Discord・Web 双方の共通ロジック） ──
// 申請の作成→オーナー通知、承認/却下→メンバー追加＋申請者通知 を一箇所に集約する。

export type SubmitResult =
	| { ok: true; requestId: number }
	| {
			ok: false;
			code: "bot_not_found" | "is_owner" | "already_member" | "already_pending";
			message: string;
	  };

/**
 * 利用申請を作成し、Botオーナーへ承認通知を送る。
 * @param applicantLabel オーナーDMに表示する申請者名（無ければ user_id を表示）
 * @param guildLabel オーナーDMに表示するギルド名（無ければ guild_id を表示）
 */
export async function submitMemberRequest(
	botId: string,
	guildId: string,
	applicantId: string,
	note?: string,
	applicantLabel?: string,
	guildLabel?: string,
): Promise<SubmitResult> {
	const bot = getBotById(botId);
	if (!bot || botId === "system_default") {
		return {
			ok: false,
			code: "bot_not_found",
			message: "対象のBotが見つかりません。",
		};
	}
	if (bot.user_id === applicantId) {
		return {
			ok: false,
			code: "is_owner",
			message: "あなたはこのBotのオーナーです（申請は不要です）。",
		};
	}

	const result = createMemberRequest(botId, guildId, applicantId, note);
	if (!result.ok) {
		return {
			ok: false,
			code: result.reason,
			message:
				result.reason === "already_member"
					? "あなたは既にこのギルドの利用メンバーです。"
					: "既に申請済みです。オーナーの承認をお待ちください。",
		};
	}

	// オーナーへ通知（送信失敗してもDB上の申請は有効。Webの承認一覧から拾える）
	await sendMemberRequestDM(
		result.request.id,
		bot.user_id,
		bot.name,
		applicantLabel?.trim() || `ユーザー ${applicantId}`,
		guildLabel?.trim() || `ギルド ${guildId}`,
		note,
	);

	return { ok: true, requestId: result.request.id };
}

export type DecisionResult =
	| { ok: true; status: "approved" | "rejected"; botName: string }
	| {
			ok: false;
			code: "not_found" | "forbidden" | "already_decided";
			message: string;
	  };

/**
 * 利用申請を承認/却下する。
 * @param deciderId 操作者（Botオーナー or Admin のみ許可）
 */
export async function decideMemberRequestById(
	requestId: number,
	decision: "approved" | "rejected",
	deciderId: string,
): Promise<DecisionResult> {
	const request = getMemberRequestById(requestId);
	if (!request) {
		return { ok: false, code: "not_found", message: "申請が見つかりません。" };
	}
	const bot = getBotById(request.bot_id);
	if (!bot) {
		return { ok: false, code: "not_found", message: "Botが見つかりません。" };
	}
	if (bot.user_id !== deciderId && !isAdmin(deciderId)) {
		return {
			ok: false,
			code: "forbidden",
			message: "このBotのオーナーのみが承認/却下できます。",
		};
	}
	if (request.status !== "pending") {
		return {
			ok: false,
			code: "already_decided",
			message: "この申請は既に処理済みです。",
		};
	}

	const moved = decideMemberRequest(requestId, decision, deciderId);
	if (!moved) {
		return {
			ok: false,
			code: "already_decided",
			message: "この申請は既に処理済みです。",
		};
	}

	if (decision === "approved") {
		// 重複は INSERT OR IGNORE で吸収される
		addBotMember(request.bot_id, request.guild_id, request.user_id, deciderId);
	}

	// 申請者へ結果を通知（失敗しても処理は確定済み）
	await sendMemberDecisionDM(
		request.user_id,
		bot.name,
		decision === "approved",
	);

	return { ok: true, status: decision, botName: bot.name };
}
