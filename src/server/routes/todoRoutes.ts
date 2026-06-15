import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { addTodo, listTodos, completeTodo, deleteTodo } from "../../db/todoRepo.js";
import { hasBotAccess } from "../../db/botRepo.js";

// ─── ToDo HTTPルート（§3.2: タグ/優先度対応） ────────────────────────────────
// パスは旧UI互換のため /api/tasks のまま。優先度は旧UIの数値(0/1/2)も受け付ける。

/** 旧UI互換: 数値優先度(0/1/2) → low/medium/high */
function normalizePriority(priority: unknown): "high" | "medium" | "low" | undefined {
  if (priority === 2 || priority === "high") return "high";
  if (priority === 1 || priority === "medium") return "medium";
  if (priority === 0 || priority === "low") return "low";
  return undefined;
}

export const todoRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/tasks",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const statusParam = ctx.url.searchParams.get("status") || "all";
      // 旧UI互換: pending → open
      const status = statusParam === "pending" ? "open" : statusParam === "done" ? "done" : "all";
      const tag = ctx.url.searchParams.get("tag") || undefined;
      const todos = listTodos(userId, botId, { status: status as "open" | "done" | "all", tag });
      sendJson(ctx.res, 200, { success: true, tasks: todos });
    },
  },
  {
    method: "POST",
    path: "/api/tasks/add",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const { title, description, dueDate, priority } = ctx.body as Record<string, unknown>;
      if (!title || typeof title !== "string") {
        return sendJson(ctx.res, 400, { success: false, message: "タイトルは必須です。" });
      }
      const todo = addTodo(userId, botId, {
        title,
        description: typeof description === "string" ? description : undefined,
        dueDate: typeof dueDate === "string" ? dueDate : undefined,
        priority: normalizePriority(priority),
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
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const id = Number(ctx.body.id);
      if (!id) return sendJson(ctx.res, 400, { success: false, message: "IDが必要です。" });
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
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const id = Number(ctx.body.id);
      if (!id) return sendJson(ctx.res, 400, { success: false, message: "IDが必要です。" });
      const ok = deleteTodo(userId, botId, id);
      sendJson(ctx.res, 200, { success: ok });
    },
  },
];
