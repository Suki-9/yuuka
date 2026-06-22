import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
	addSchedule,
	listUpcomingSchedules,
	deleteSchedule,
} from "../../db/scheduleRepo.js";
import { hasBotAccess } from "../../db/botRepo.js";

// ─── 予定 HTTPルート（§3.2） ─────────────────────────────────────────────────

export const scheduleRoutes: RouteDef[] = [
	{
		method: "GET",
		path: "/api/schedules",
		auth: "user",
		async handler(ctx) {
			const days = parseInt(ctx.url.searchParams.get("days") || "7", 10);
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const schedules = listUpcomingSchedules(userId, botId, days);
			sendJson(ctx.res, 200, { success: true, schedules });
		},
	},
	{
		method: "POST",
		path: "/api/schedules/add",
		auth: "user",
		async handler(ctx) {
			const { title, startAt, endAt, remindBeforeMinutes, description } =
				ctx.body as Record<string, unknown>;
			if (
				!title ||
				typeof title !== "string" ||
				!startAt ||
				typeof startAt !== "string"
			) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "タイトルと開始日時は必須です。",
				});
			}
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const schedule = addSchedule(
				userId,
				botId,
				title,
				startAt,
				typeof endAt === "string" ? endAt : undefined,
				remindBeforeMinutes !== undefined
					? Number(remindBeforeMinutes)
					: undefined,
				typeof description === "string" ? description : undefined,
			);
			sendJson(ctx.res, 200, { success: true, schedule });
		},
	},
	{
		method: "POST",
		path: "/api/schedules/delete",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "IDが必要です。",
				});
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const ok = deleteSchedule(id, userId, botId);
			sendJson(ctx.res, 200, { success: ok });
		},
	},
];
