import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { findPlaybooks, savePlaybook, deletePlaybook } from "../../services/playbookService.js";
import {
  listSchedules,
  upsertSchedule,
  toggleSchedule,
  deleteSchedule,
  listRuns,
} from "../../services/playbookScheduleService.js";
import { hasBotAccess } from "../../db/botRepo.js";

// ─── マクロ（Playbook）HTTPルート（§3.6） ────────────────────────────────────

export const playbookRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/playbooks",
    auth: "user",
    async handler(ctx) {
      const query = ctx.url.searchParams.get("query") || undefined;
      sendJson(ctx.res, 200, { success: true, playbooks: findPlaybooks(ctx.user!.discordId, query) });
    },
  },
  {
    method: "POST",
    path: "/api/playbooks/save",
    auth: "user",
    async handler(ctx) {
      const { name, title, keywords, description, steps } = ctx.body as Record<string, unknown>;
      if (!name || typeof name !== "string" || !title || typeof title !== "string" || !steps || typeof steps !== "string") {
        return sendJson(ctx.res, 400, { success: false, message: "マクロ名、タイトル、および手順ステップは必須です。" });
      }
      const keywordsList = Array.isArray(keywords) ? keywords.map(String) : [];
      const result = savePlaybook(
        ctx.user!.discordId,
        name,
        title,
        keywordsList,
        typeof description === "string" ? description : "",
        steps
      );
      sendJson(ctx.res, 200, result);
    },
  },
  {
    method: "POST",
    path: "/api/playbooks/delete",
    auth: "user",
    async handler(ctx) {
      const { name } = ctx.body as Record<string, string>;
      if (!name) return sendJson(ctx.res, 400, { success: false, message: "マクロ名は必須です。" });
      const success = deletePlaybook(ctx.user!.discordId, name);
      sendJson(ctx.res, 200, { success, message: success ? "マクロを削除しました。" : "削除に失敗しました。" });
    },
  },

  // ── 定期実行スケジュール ──
  {
    method: "GET",
    path: "/api/playbooks/schedules",
    auth: "user",
    async handler(ctx) {
      sendJson(ctx.res, 200, { success: true, schedules: listSchedules(ctx.user!.discordId) });
    },
  },
  {
    method: "POST",
    path: "/api/playbooks/schedules/save",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const { playbookName, cronExpression, description, enabled, botId } = ctx.body as Record<string, unknown>;
      if (!playbookName || typeof playbookName !== "string" || !cronExpression || typeof cronExpression !== "string") {
        return sendJson(ctx.res, 400, { success: false, message: "playbookNameとcronExpressionは必須です。" });
      }
      const result = upsertSchedule(
        userId,
        playbookName,
        cronExpression,
        typeof description === "string" ? description : "",
        enabled !== false,
        typeof botId === "string" && botId && hasBotAccess(userId, botId) ? botId : "system_default"
      );
      sendJson(ctx.res, result.success ? 200 : 400, result);
    },
  },
  {
    method: "POST",
    path: "/api/playbooks/schedules/toggle",
    auth: "user",
    async handler(ctx) {
      const { id, enabled } = ctx.body as Record<string, unknown>;
      if (id == null) return sendJson(ctx.res, 400, { success: false, message: "idは必須です。" });
      const result = toggleSchedule(ctx.user!.discordId, Number(id), !!enabled);
      sendJson(ctx.res, result.success ? 200 : 400, result);
    },
  },
  {
    method: "POST",
    path: "/api/playbooks/schedules/delete",
    auth: "user",
    async handler(ctx) {
      const id = ctx.body.id;
      if (id == null) return sendJson(ctx.res, 400, { success: false, message: "idは必須です。" });
      const result = deleteSchedule(ctx.user!.discordId, Number(id));
      sendJson(ctx.res, result.success ? 200 : 400, result);
    },
  },
  {
    method: "GET",
    path: "/api/playbooks/runs",
    auth: "user",
    async handler(ctx) {
      const scheduleIdParam = ctx.url.searchParams.get("scheduleId");
      const scheduleId = scheduleIdParam ? Number(scheduleIdParam) : undefined;
      sendJson(ctx.res, 200, { success: true, runs: listRuns(ctx.user!.discordId, scheduleId) });
    },
  },
];
