import cron from "node-cron";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
  getBriefingConfig,
  upsertBriefingConfig,
  parseJsonArray,
} from "../../db/briefingConfigRepo.js";
import {
  getReportConfigs,
  upsertReportConfig,
  type ReportType,
} from "../../db/reportConfigRepo.js";
import { runBriefingForUser } from "../../services/briefingService.js";
import { runReportForUser } from "../../services/reportService.js";
import { hasBotAccess } from "../../db/botRepo.js";
import { isLikelyPublicHttpUrl } from "../../utils/ssrfGuard.js";

// ─── 朝報・日報・週報 配信設定 HTTPルート（§3.8.3, §3.9.3） ──────────────────

export const deliveryRoutes: RouteDef[] = [
  // ── 朝報設定 ──
  {
    method: "GET",
    path: "/api/briefing-config",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const config = getBriefingConfig(userId, botId);
      sendJson(ctx.res, 200, {
        success: true,
        config: config
          ? {
              enabled: config.enabled === 1,
              schedule_cron: config.schedule_cron,
              target_type: config.target_type,
              target_id: config.target_id,
              weather_lat: config.weather_lat,
              weather_lng: config.weather_lng,
              location_name: config.location_name,
              news_feeds: parseJsonArray(config.news_feeds),
              news_keywords: parseJsonArray(config.news_keywords),
            }
          : null,
      });
    },
  },
  {
    method: "POST",
    path: "/api/briefing-config",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const b = ctx.body;
      if (typeof b.schedule_cron === "string" && !cron.validate(b.schedule_cron)) {
        return sendJson(ctx.res, 400, { success: false, message: "cron式が不正です。" });
      }
      const rawBotId = (b.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";

      // SSRF対策: ニュースフィードURLにローカル/内部宛先や非http(s)を許可しない
      if (Array.isArray(b.news_feeds)) {
        const feeds = (b.news_feeds as unknown[]).map(String).filter((s) => s.trim());
        const bad = feeds.find((f) => !isLikelyPublicHttpUrl(f));
        if (bad) {
          return sendJson(ctx.res, 400, { success: false, message: `不正なフィードURLです（http(s)の公開URLのみ指定できます）: ${bad}` });
        }
      }

      upsertBriefingConfig(userId, botId, {
        ...(b.enabled !== undefined ? { enabled: b.enabled === true } : {}),
        ...(typeof b.schedule_cron === "string" ? { scheduleCron: b.schedule_cron } : {}),
        ...(b.target_type !== undefined
          ? { targetType: b.target_type === "channel" ? ("channel" as const) : ("dm" as const) }
          : {}),
        ...(b.target_id !== undefined
          ? { targetId: typeof b.target_id === "string" && b.target_id.trim() ? b.target_id.trim() : null }
          : {}),
        ...(b.weather_lat !== undefined
          ? { weatherLat: b.weather_lat === null || b.weather_lat === "" ? null : Number(b.weather_lat) }
          : {}),
        ...(b.weather_lng !== undefined
          ? { weatherLng: b.weather_lng === null || b.weather_lng === "" ? null : Number(b.weather_lng) }
          : {}),
        ...(b.location_name !== undefined
          ? { locationName: typeof b.location_name === "string" && b.location_name.trim() ? b.location_name.trim() : null }
          : {}),
        ...(Array.isArray(b.news_feeds) ? { newsFeeds: (b.news_feeds as unknown[]).map(String) } : {}),
        ...(Array.isArray(b.news_keywords) ? { newsKeywords: (b.news_keywords as unknown[]).map(String) } : {}),
      });

      sendJson(ctx.res, 200, { success: true, message: "朝報の設定を保存しました。" });
    },
  },
  {
    method: "POST",
    path: "/api/briefing/test",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const config = getBriefingConfig(userId, botId);
      if (!config) {
        return sendJson(ctx.res, 400, { success: false, message: "朝報がまだ設定されていません。先に設定を保存してください。" });
      }
      const sent = await runBriefingForUser(userId, botId);
      sendJson(ctx.res, 200, {
        success: sent,
        message: sent ? "朝報をテスト配信しました。Discordを確認してください。" : "配信に失敗しました。Botが起動しているか確認してください。",
      });
    },
  },

  // ── 日報・週報設定 ──
  {
    method: "GET",
    path: "/api/report-configs",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const configs = getReportConfigs(userId, botId).map((c) => ({
        type: c.type,
        enabled: c.enabled === 1,
        schedule_cron: c.schedule_cron,
        target_type: c.target_type,
        target_id: c.target_id,
      }));
      sendJson(ctx.res, 200, { success: true, configs });
    },
  },
  {
    method: "POST",
    path: "/api/report-configs",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const type = ctx.body.type;
      if (type !== "daily" && type !== "weekly") {
        return sendJson(ctx.res, 400, { success: false, message: "type は 'daily' または 'weekly' を指定してください。" });
      }
      if (typeof ctx.body.schedule_cron === "string" && !cron.validate(ctx.body.schedule_cron)) {
        return sendJson(ctx.res, 400, { success: false, message: "cron式が不正です。" });
      }
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";

      upsertReportConfig(userId, botId, type as ReportType, {
        ...(ctx.body.enabled !== undefined ? { enabled: ctx.body.enabled === true } : {}),
        ...(typeof ctx.body.schedule_cron === "string" ? { scheduleCron: ctx.body.schedule_cron } : {}),
        ...(ctx.body.target_type !== undefined
          ? { targetType: ctx.body.target_type === "channel" ? ("channel" as const) : ("dm" as const) }
          : {}),
        ...(ctx.body.target_id !== undefined
          ? { targetId: typeof ctx.body.target_id === "string" && ctx.body.target_id.trim() ? ctx.body.target_id.trim() : null }
          : {}),
      });

      sendJson(ctx.res, 200, { success: true, message: `${type === "daily" ? "日報" : "週報"}の設定を保存しました。` });
    },
  },
  {
    method: "POST",
    path: "/api/report-configs/test",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const type = ctx.body.type === "weekly" ? "weekly" : "daily";
      const rawBotId = (ctx.body.botId as string | undefined) ?? ctx.url.searchParams.get("botId") ?? undefined;
      const botId = rawBotId && hasBotAccess(userId, rawBotId) ? rawBotId : "system_default";
      const sent = await runReportForUser(userId, botId, type as ReportType);
      sendJson(ctx.res, 200, {
        success: sent,
        message: sent ? "レポートをテスト配信しました。" : "配信に失敗しました。",
      });
    },
  },
];
