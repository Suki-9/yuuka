import type { RouteDef, RouteRequestCtx } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
	addTodo,
	completeTodo,
	computeEffectiveProgress,
	deleteTodo,
	getTodoById,
	listGanttTasks,
	listProgressLogs,
	listSomedayTasks,
	listSubtasks,
	listTodoTree,
	updateProgress,
	updateTodo,
} from "../../db/todoRepo.js";
import { hasBotAccess } from "../../db/botRepo.js";

// ─── ToDo HTTPルート（§3.2: タグ/優先度/進捗/サブタスク/ガント対応） ──────────
// パスは旧UI互換のため /api/tasks のまま。優先度は旧UIの数値(0/1/2)も受け付ける。

/** 旧UI互換: 数値優先度(0/1/2) → low/medium/high */
function normalizePriority(
	priority: unknown,
): "high" | "medium" | "low" | undefined {
	if (priority === 2 || priority === "high") return "high";
	if (priority === 1 || priority === "medium") return "medium";
	if (priority === 0 || priority === "low") return "low";
	return undefined;
}

/** body / クエリの botId を本人のアクセス可能なBotへ解決（不正・未指定は system_default） */
function resolveBotId(ctx: RouteRequestCtx, userId: string): string {
	const rawBotId =
		(ctx.body.botId as string | undefined) ??
		ctx.url.searchParams.get("botId") ??
		undefined;
	return rawBotId && hasBotAccess(userId, rawBotId)
		? rawBotId
		: "system_default";
}

/** 任意フィールドを文字列として取り出す（未指定は undefined、それ以外は文字列化なし） */
function optString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export const todoRoutes: RouteDef[] = [
	{
		method: "GET",
		path: "/api/tasks",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const statusParam = ctx.url.searchParams.get("status") || "all";
			// 旧UI互換: pending → open
			const status =
				statusParam === "pending"
					? "open"
					: statusParam === "done"
						? "done"
						: "all";
			const tag = ctx.url.searchParams.get("tag") || undefined;
			// v12: 親タスクごとにサブタスク・算出進捗を入れ子で返す
			const tasks = listTodoTree(userId, botId, {
				status: status as "open" | "done" | "all",
				tag,
			});
			sendJson(ctx.res, 200, { success: true, tasks });
		},
	},
	{
		// v12: ガント表示対象（開始日 or 期限を持つ親タスク＋サブタスク）
		method: "GET",
		path: "/api/tasks/gantt",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const tasks = listGanttTasks(userId, botId);
			sendJson(ctx.res, 200, { success: true, tasks });
		},
	},
	{
		// v12: 「いつかやる」（開始日・期限とも未設定の親タスク）
		method: "GET",
		path: "/api/tasks/someday",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const tasks = listSomedayTasks(userId, botId);
			sendJson(ctx.res, 200, { success: true, tasks });
		},
	},
	{
		// v12: タスク詳細（サブタスク・算出進捗・進捗履歴）
		method: "GET",
		path: "/api/tasks/detail",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const id = Number(ctx.url.searchParams.get("id"));
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "IDが必要です。",
				});
			const task = getTodoById(userId, botId, id);
			if (!task)
				return sendJson(ctx.res, 404, {
					success: false,
					message: "タスクが見つかりません。",
				});
			const subtasks = listSubtasks(userId, botId, id);
			const progressLogs = listProgressLogs(userId, botId, id);
			sendJson(ctx.res, 200, {
				success: true,
				task,
				subtasks,
				effectiveProgress: computeEffectiveProgress(task, subtasks),
				progressLogs,
			});
		},
	},
	{
		method: "POST",
		path: "/api/tasks/add",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const body = ctx.body as Record<string, unknown>;
			const { title } = body;
			if (!title || typeof title !== "string") {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "タイトルは必須です。",
				});
			}
			// v12: parentId 指定時はサブタスクとして登録（repo 側で1階層へ正規化）
			const parentId =
				body.parentId != null && Number.isFinite(Number(body.parentId))
					? Number(body.parentId)
					: undefined;
			const todo = addTodo(userId, botId, {
				title,
				description: optString(body.description),
				dueDate: optString(body.dueDate),
				startDate: optString(body.startDate),
				priority: normalizePriority(body.priority),
				parentId,
			});
			sendJson(ctx.res, 200, { success: true, task: todo });
		},
	},
	{
		// v12: タスク更新（タイトル/説明/期限/開始日/優先度/ステータス）。UI編集・ガント編集用
		method: "POST",
		path: "/api/tasks/update",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const body = ctx.body as Record<string, unknown>;
			const id = Number(body.id);
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "IDが必要です。",
				});
			const statusRaw = optString(body.status);
			const status =
				statusRaw === "open" || statusRaw === "done" ? statusRaw : undefined;
			const todo = updateTodo(userId, botId, id, {
				title: optString(body.title),
				description: optString(body.description),
				dueDate: optString(body.dueDate),
				startDate: optString(body.startDate),
				priority: normalizePriority(body.priority),
				status,
			});
			if (!todo)
				return sendJson(ctx.res, 404, {
					success: false,
					message: "タスクが見つかりません。",
				});
			sendJson(ctx.res, 200, { success: true, task: todo });
		},
	},
	{
		// v12: 進捗更新（0-100）＋進捗ログ追記。サブタスクを持つ親は子から算出のため拒否
		method: "POST",
		path: "/api/tasks/progress",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const body = ctx.body as Record<string, unknown>;
			const id = Number(body.id);
			const progress = Number(body.progress);
			if (!id || !Number.isFinite(progress))
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id と progress（0〜100）が必要です。",
				});
			const subtasks = listSubtasks(userId, botId, id);
			if (subtasks.length > 0)
				return sendJson(ctx.res, 409, {
					success: false,
					message:
						"このタスクはサブタスクを持つため、進捗は自動算出されます（手動更新不可）。",
				});
			const todo = updateProgress(
				userId,
				botId,
				id,
				progress,
				optString(body.note),
			);
			if (!todo)
				return sendJson(ctx.res, 404, {
					success: false,
					message: "タスクが見つかりません。",
				});
			sendJson(ctx.res, 200, { success: true, task: todo });
		},
	},
	{
		method: "POST",
		path: "/api/tasks/complete",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const id = Number(ctx.body.id);
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "IDが必要です。",
				});
			const todo = completeTodo(userId, botId, id);
			sendJson(ctx.res, 200, { success: !!todo, task: todo });
		},
	},
	{
		method: "POST",
		path: "/api/tasks/delete",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveBotId(ctx, userId);
			const id = Number(ctx.body.id);
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "IDが必要です。",
				});
			// 親削除時はサブタスク・進捗ログも一緒に削除される（deleteTodo が明示的に連鎖削除）
			const ok = deleteTodo(userId, botId, id);
			sendJson(ctx.res, 200, { success: ok });
		},
	},
];
