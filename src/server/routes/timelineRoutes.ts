import fs from "node:fs";
import path from "node:path";
import { hasBotAccess } from "../../db/botRepo.js";
import {
	addDayPlanBlock,
	addExpenseRecord,
	addTimelineRecord,
	deleteDayPlanBlock,
	deleteTimelineRecord,
	listDayPlanBlocks,
	listTimelineRecords,
	resolveMediaPath,
	saveMediaFile,
	updateDayPlanBlock,
	type PlanBlockType,
	type RecordType,
} from "../../db/timelineRepo.js";
import { completeTodo } from "../../db/todoRepo.js";
import type { RouteDef, RouteRequestCtx } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ─── デイリータイムライン HTTPルート ──────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
	".heic": "image/heic",
	".heif": "image/heif",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".m4v": "video/x-m4v",
};

function resolveBotId(ctx: RouteRequestCtx, userId: string): string {
	const rawBotId =
		(ctx.body.botId as string | undefined) ??
		ctx.url.searchParams.get("botId") ??
		undefined;
	return rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
}

function scope(ctx: RouteRequestCtx) {
	const userId = ctx.user!.discordId;
	return { userId, botId: resolveBotId(ctx, userId) };
}

export const timelineRoutes: RouteDef[] = [
	// ── 1日分まとめ取得 ──────────────────────────────────────────────────────
	{
		method: "GET",
		path: "/api/timeline/day",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const date = ctx.url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
			const blocks = listDayPlanBlocks(userId, botId, date);
			const records = listTimelineRecords(userId, botId, date);
			sendJson(ctx.res, 200, { success: true, blocks, records });
		},
	},

	// ── 計画ブロック CRUD ────────────────────────────────────────────────────
	{
		method: "POST",
		path: "/api/timeline/plan",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const b = ctx.body as Record<string, unknown>;
			const { date, type, title } = b;
			if (!date || !type || !title || typeof date !== "string" || typeof title !== "string") {
				return sendJson(ctx.res, 400, { success: false, message: "date / type / title が必要です。" });
			}
			const block = addDayPlanBlock(userId, botId, {
				date,
				type: type as PlanBlockType,
				title,
				description: typeof b.description === "string" ? b.description : undefined,
				startTime: typeof b.startTime === "string" ? b.startTime : undefined,
				endTime: typeof b.endTime === "string" ? b.endTime : undefined,
				todoId: typeof b.todoId === "number" ? b.todoId : undefined,
				transitFrom: typeof b.transitFrom === "string" ? b.transitFrom : undefined,
				transitTo: typeof b.transitTo === "string" ? b.transitTo : undefined,
				transitLine: typeof b.transitLine === "string" ? b.transitLine : undefined,
				position: typeof b.position === "number" ? b.position : undefined,
			});
			sendJson(ctx.res, 200, { success: true, block });
		},
	},
	{
		method: "POST",
		path: "/api/timeline/plan/update",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const b = ctx.body as Record<string, unknown>;
			const id = Number(b.id);
			if (!id) return sendJson(ctx.res, 400, { success: false, message: "id が必要です。" });
			const block = updateDayPlanBlock(userId, botId, id, {
				title: typeof b.title === "string" ? b.title : undefined,
				description: typeof b.description === "string" ? b.description : undefined,
				startTime: "startTime" in b ? (b.startTime as string | undefined) : undefined,
				endTime: "endTime" in b ? (b.endTime as string | undefined) : undefined,
				type: typeof b.type === "string" ? (b.type as PlanBlockType) : undefined,
				todoId: "todoId" in b ? (b.todoId as number | undefined) : undefined,
				transitFrom: "transitFrom" in b ? (b.transitFrom as string | undefined) : undefined,
				transitTo: "transitTo" in b ? (b.transitTo as string | undefined) : undefined,
				transitLine: "transitLine" in b ? (b.transitLine as string | undefined) : undefined,
			});
			if (!block) return sendJson(ctx.res, 404, { success: false, message: "ブロックが見つかりません。" });
			sendJson(ctx.res, 200, { success: true, block });
		},
	},
	{
		method: "POST",
		path: "/api/timeline/plan/delete",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const id = Number(ctx.body.id);
			if (!id) return sendJson(ctx.res, 400, { success: false, message: "id が必要です。" });
			const ok = deleteDayPlanBlock(userId, botId, id);
			sendJson(ctx.res, 200, { success: ok });
		},
	},

	// ── 記録 CRUD ────────────────────────────────────────────────────────────
	{
		method: "POST",
		path: "/api/timeline/record",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const b = ctx.body as Record<string, unknown>;
			const { date, type } = b;
			if (!date || !type || typeof date !== "string" || typeof type !== "string") {
				return sendJson(ctx.res, 400, { success: false, message: "date / type が必要です。" });
			}

			// 支出は expenses にも同時登録
			if (type === "expense") {
				const amount = Number(b.amount);
				const category = typeof b.category === "string" ? b.category : "その他";
				if (!amount) return sendJson(ctx.res, 400, { success: false, message: "amount が必要です。" });
				const record = await addExpenseRecord(userId, botId, {
					date,
					recordedAt: typeof b.recordedAt === "string" ? b.recordedAt : undefined,
					amount,
					category,
					title: typeof b.title === "string" ? b.title : undefined,
					location: typeof b.location === "string" ? b.location : undefined,
				});
				return sendJson(ctx.res, 200, { success: true, record });
			}

			// タスク完了は todos にも反映
			if (type === "task_done" && typeof b.todoId === "number") {
				completeTodo(userId, botId, b.todoId);
			}

			const record = addTimelineRecord(userId, botId, {
				date,
				recordedAt: typeof b.recordedAt === "string" ? b.recordedAt : undefined,
				type: type as RecordType,
				title: typeof b.title === "string" ? b.title : undefined,
				content: typeof b.content === "string" ? b.content : undefined,
				todoId: typeof b.todoId === "number" ? b.todoId : undefined,
				location: typeof b.location === "string" ? b.location : undefined,
			});
			sendJson(ctx.res, 200, { success: true, record });
		},
	},
	{
		method: "POST",
		path: "/api/timeline/record/delete",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const id = Number(ctx.body.id);
			if (!id) return sendJson(ctx.res, 400, { success: false, message: "id が必要です。" });
			const ok = deleteTimelineRecord(userId, botId, id);
			sendJson(ctx.res, 200, { success: ok });
		},
	},

	// ── メディアアップロード（base64 JSON） ──────────────────────────────────
	{
		method: "POST",
		path: "/api/timeline/media",
		auth: "user",
		async handler(ctx) {
			const { userId, botId } = scope(ctx);
			const b = ctx.body as Record<string, unknown>;
			const { date, base64, mimeType } = b;
			if (!date || !base64 || !mimeType || typeof date !== "string" || typeof base64 !== "string" || typeof mimeType !== "string") {
				return sendJson(ctx.res, 400, { success: false, message: "date / base64 / mimeType が必要です。" });
			}
			try {
				const mediaPath = await saveMediaFile({ base64, mimeType, date });
				const mediaType = mimeType.startsWith("video/") ? "video" : "photo";
				const record = addTimelineRecord(userId, botId, {
					date,
					recordedAt: typeof b.recordedAt === "string" ? b.recordedAt : undefined,
					type: "media",
					title: typeof b.title === "string" ? b.title : undefined,
					content: typeof b.content === "string" ? b.content : undefined,
					mediaPath,
					mediaType,
					location: typeof b.location === "string" ? b.location : undefined,
				});
				sendJson(ctx.res, 200, { success: true, record });
			} catch (e) {
				sendJson(ctx.res, 400, { success: false, message: (e as Error).message });
			}
		},
	},

	// ── メディア配信（認証付き静的ファイル） ─────────────────────────────────
	{
		method: "GET",
		path: "/api/timeline/media/:filename",
		auth: "user",
		async handler(ctx) {
			const filename = ctx.params.filename;
			const fullPath = resolveMediaPath(filename);
			if (!fullPath || !fs.existsSync(fullPath)) {
				ctx.res.writeHead(404);
				ctx.res.end("Not Found");
				return;
			}
			const ext = path.extname(filename).toLowerCase();
			const contentType = MIME_MAP[ext] ?? "application/octet-stream";
			ctx.res.writeHead(200, {
				"Content-Type": contentType,
				"Cache-Control": "private, max-age=86400",
			});
			fs.createReadStream(fullPath).pipe(ctx.res);
		},
	},
];
