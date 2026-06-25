import { addAuditLog } from "../../db/auditRepo.js";
import {
	getMemberRequestById,
	listMemberRequestsByUser,
	listMemberRequestsForBot,
} from "../../db/botMemberRequestRepo.js";
import { getBotById, listBotsOwnedBy } from "../../db/botRepo.js";
import { isAdmin } from "../../db/userRepo.js";
import {
	decideMemberRequestById,
	submitMemberRequest,
} from "../../services/memberRequest.js";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ─── ギルド利用メンバーの利用申請 HTTPルート ─────────────────────────────────
// 申請（申請者）/ 自分の申請状況 / オーナー向け承認一覧 / 承認・却下 を提供する。

function isSnowflake(value: string): boolean {
	return /^\d{5,25}$/.test(value);
}

export const memberRequestRoutes: RouteDef[] = [
	// ── 利用申請を作成（申請者。botId+guildId 指定） ──
	{
		method: "POST",
		path: "/api/bots/member-requests",
		auth: "user",
		async handler(ctx) {
			const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
			const guildId =
				typeof ctx.body.guildId === "string" ? ctx.body.guildId.trim() : "";
			const note =
				typeof ctx.body.note === "string" ? ctx.body.note : undefined;
			if (!botId || !isSnowflake(guildId)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "botId とギルドID（数字）が必要です。",
				});
			}

			const result = await submitMemberRequest(
				botId,
				guildId,
				ctx.user!.discordId,
				note,
			);
			if (!result.ok) {
				const status = result.code === "bot_not_found" ? 404 : 409;
				return sendJson(ctx.res, status, {
					success: false,
					message: result.message,
				});
			}
			addAuditLog(
				ctx.user!.discordId,
				"bot.member_request_submit",
				`${botId}:${guildId}`,
			);
			sendJson(ctx.res, 200, {
				success: true,
				message: "利用申請を送信しました。Bot作成者の承認をお待ちください。",
			});
		},
	},

	// ── 自分の申請状況一覧（申請者） ──
	{
		method: "GET",
		path: "/api/bots/member-requests/mine",
		auth: "user",
		async handler(ctx) {
			const requests = listMemberRequestsByUser(ctx.user!.discordId).map(
				(r) => ({
					...r,
					bot_name: getBotById(r.bot_id)?.name ?? r.bot_id,
				}),
			);
			sendJson(ctx.res, 200, { success: true, requests });
		},
	},

	// ── オーナー向け: 自分が所有するBot宛の申請一覧（status で絞り込み可） ──
	{
		method: "GET",
		path: "/api/bots/member-requests",
		auth: "user",
		async handler(ctx) {
			const statusFilter = ctx.url.searchParams.get("status");
			const status =
				statusFilter === "pending" ||
				statusFilter === "approved" ||
				statusFilter === "rejected"
					? statusFilter
					: undefined;

			const botIdFilter = ctx.url.searchParams.get("botId");
			// 申請を閲覧できるのは所有Botのみ（Admin は botId 指定で任意Botを対象にできる）
			let bots = listBotsOwnedBy(ctx.user!.discordId);
			if (botIdFilter) {
				if (isAdmin(ctx.user!.discordId)) {
					const b = getBotById(botIdFilter);
					bots = b ? [b] : [];
				} else {
					bots = bots.filter((b) => b.id === botIdFilter);
				}
			}

			const requests = bots.flatMap((b) =>
				listMemberRequestsForBot(b.id, status).map((r) => ({
					...r,
					bot_name: b.name,
				})),
			);
			requests.sort((a, b) => b.created_at.localeCompare(a.created_at));
			sendJson(ctx.res, 200, { success: true, requests });
		},
	},

	// ── オーナー向け: 承認/却下 ──
	{
		method: "POST",
		path: "/api/bots/member-requests/:id/decide",
		auth: "user",
		async handler(ctx) {
			const id = parseInt(ctx.params.id ?? "", 10);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "申請IDが不正です。",
				});
			}
			const decision =
				ctx.body.decision === "approved" || ctx.body.action === "approve"
					? "approved"
					: ctx.body.decision === "rejected" || ctx.body.action === "reject"
						? "rejected"
						: null;
			if (!decision) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "decision（approved/rejected）が必要です。",
				});
			}

			const existing = getMemberRequestById(id);
			const result = await decideMemberRequestById(
				id,
				decision,
				ctx.user!.discordId,
			);
			if (!result.ok) {
				const status =
					result.code === "not_found"
						? 404
						: result.code === "forbidden"
							? 403
							: 409;
				return sendJson(ctx.res, status, {
					success: false,
					message: result.message,
				});
			}
			addAuditLog(
				ctx.user!.discordId,
				decision === "approved"
					? "bot.member_request_approve"
					: "bot.member_request_reject",
				existing
					? `${existing.bot_id}:${existing.guild_id}:${existing.user_id}`
					: String(id),
			);
			sendJson(ctx.res, 200, {
				success: true,
				message:
					decision === "approved"
						? "利用申請を承認しました。"
						: "利用申請を却下しました。",
			});
		},
	},
];
