import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { addSchedule, listUpcomingSchedules, deleteSchedule } from "../../db/scheduleRepo.js";

// ─── 予定 HTTPルート（§3.2） ─────────────────────────────────────────────────

export const scheduleRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/schedules",
    auth: "user",
    async handler(ctx) {
      const days = parseInt(ctx.url.searchParams.get("days") || "7", 10);
      const schedules = listUpcomingSchedules(ctx.user!.discordId, days);
      sendJson(ctx.res, 200, { success: true, schedules });
    },
  },
  {
    method: "POST",
    path: "/api/schedules/add",
    auth: "user",
    async handler(ctx) {
      const { title, startAt, endAt, remindBeforeMinutes, description } = ctx.body as Record<string, unknown>;
      if (!title || typeof title !== "string" || !startAt || typeof startAt !== "string") {
        return sendJson(ctx.res, 400, { success: false, message: "タイトルと開始日時は必須です。" });
      }
      const schedule = addSchedule(
        ctx.user!.discordId,
        title,
        startAt,
        typeof endAt === "string" ? endAt : undefined,
        remindBeforeMinutes !== undefined ? Number(remindBeforeMinutes) : undefined,
        typeof description === "string" ? description : undefined
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
      if (!id) return sendJson(ctx.res, 400, { success: false, message: "IDが必要です。" });
      const ok = deleteSchedule(id, ctx.user!.discordId);
      sendJson(ctx.res, 200, { success: ok });
    },
  },
];
