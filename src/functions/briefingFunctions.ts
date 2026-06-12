import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import cron from "node-cron";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
  getBriefingConfig,
  upsertBriefingConfig,
  parseJsonArray,
} from "../db/briefingConfigRepo.js";
import {
  upsertReportConfig,
  getReportConfigs,
  type ReportType,
} from "../db/reportConfigRepo.js";
import { runBriefingForUser } from "../services/briefingService.js";

// ─── 朝報・日報・週報の設定 Function（§3.8.3, §3.9） ─────────────────────────
// チャットから配信設定を変更できるようにする（Web管理画面と同じ設定を操作）。

const declarations: FunctionDeclaration[] = [
  {
    name: "configureBriefing",
    description:
      "朝報（毎朝の天気・ニュース定期配信 §3.9）の設定を変更します。" +
      "「毎朝7時に天気を送って」「ニュースフィードに○○を追加して」などの依頼時に呼び出します。" +
      "天気の地点は緯度経度で指定します（地名を言われたら、知っている代表的な緯度経度へ変換して設定し、location_name に地名を入れる）。" +
      "変更したい項目のみ指定してください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        enabled: { type: SchemaType.BOOLEAN, description: "配信の有効/無効" },
        schedule_cron: {
          type: SchemaType.STRING,
          description: "配信時刻のcron式（例: '0 7 * * *' = 毎朝7時）",
        },
        latitude: { type: SchemaType.NUMBER, description: "天気取得地点の緯度（例: 東京=35.68）" },
        longitude: { type: SchemaType.NUMBER, description: "天気取得地点の経度（例: 東京=139.77）" },
        location_name: { type: SchemaType.STRING, description: "地点の表示名（例: '東京'）" },
        add_news_feed: { type: SchemaType.STRING, description: "追加するRSSフィードURL" },
        remove_news_feed: { type: SchemaType.STRING, description: "削除するRSSフィードURL（部分一致可）" },
        news_keywords: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "ニュースのキーワードフィルタ（全置換。空配列でフィルタ解除）",
        },
      },
    },
  },
  {
    name: "getBriefingConfig",
    description: "朝報（天気・ニュース定期配信）の現在の設定と、日報・週報の配信設定を確認します。",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "configureReport",
    description:
      "日報・週報（活動サマリの自動配信 §3.8）の設定を変更します。" +
      "「毎日21時に日報を送って」「週報を有効にして」などの依頼時に呼び出します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: { type: SchemaType.STRING, description: "'daily'（日報）または 'weekly'（週報）" },
        enabled: { type: SchemaType.BOOLEAN, description: "配信の有効/無効" },
        schedule_cron: {
          type: SchemaType.STRING,
          description: "配信時刻のcron式（例: 日報 '0 21 * * *' = 毎日21時、週報 '0 21 * * 0' = 毎週日曜21時）",
        },
      },
      required: ["type"],
    },
  },
  {
    name: "runBriefingNow",
    description: "朝報を今すぐテスト配信します。設定変更後の動作確認に使います。",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
];

const handlers: FunctionModule["handlers"] = {
  configureBriefing(ctx: ToolContext, args: Record<string, unknown>): string {
    const userId = ctx.userId;

    if (args.schedule_cron !== undefined && !cron.validate(String(args.schedule_cron))) {
      return JSON.stringify({ success: false, message: "schedule_cron のcron式が不正です。" });
    }
    if (args.add_news_feed !== undefined) {
      try {
        new URL(String(args.add_news_feed));
      } catch {
        return JSON.stringify({ success: false, message: "add_news_feed のURL形式が不正です。" });
      }
    }

    const current = getBriefingConfig(userId);
    let feeds = parseJsonArray(current?.news_feeds);

    if (args.add_news_feed !== undefined) {
      const url = String(args.add_news_feed).trim();
      if (!feeds.includes(url)) feeds.push(url);
    }
    if (args.remove_news_feed !== undefined) {
      const target = String(args.remove_news_feed).trim();
      feeds = feeds.filter((f) => !f.includes(target));
    }

    const updated = upsertBriefingConfig(userId, {
      ...(args.enabled !== undefined ? { enabled: args.enabled === true } : {}),
      ...(args.schedule_cron !== undefined ? { scheduleCron: String(args.schedule_cron) } : {}),
      ...(args.latitude !== undefined ? { weatherLat: Number(args.latitude) } : {}),
      ...(args.longitude !== undefined ? { weatherLng: Number(args.longitude) } : {}),
      ...(args.location_name !== undefined ? { locationName: String(args.location_name) } : {}),
      ...(args.add_news_feed !== undefined || args.remove_news_feed !== undefined
        ? { newsFeeds: feeds }
        : {}),
      ...(Array.isArray(args.news_keywords)
        ? { newsKeywords: (args.news_keywords as unknown[]).map(String) }
        : {}),
    });

    return JSON.stringify({
      success: true,
      message: "朝報の設定を更新しました🌅",
      config: {
        enabled: updated.enabled === 1,
        schedule_cron: updated.schedule_cron,
        location: updated.location_name,
        weather_lat: updated.weather_lat,
        weather_lng: updated.weather_lng,
        news_feeds: parseJsonArray(updated.news_feeds),
        news_keywords: parseJsonArray(updated.news_keywords),
      },
    });
  },

  getBriefingConfig(ctx: ToolContext): string {
    const briefing = getBriefingConfig(ctx.userId);
    const reports = getReportConfigs(ctx.userId);
    return JSON.stringify({
      success: true,
      briefing: briefing
        ? {
            enabled: briefing.enabled === 1,
            schedule_cron: briefing.schedule_cron,
            location: briefing.location_name,
            weather_lat: briefing.weather_lat,
            weather_lng: briefing.weather_lng,
            news_feeds: parseJsonArray(briefing.news_feeds),
            news_keywords: parseJsonArray(briefing.news_keywords),
          }
        : null,
      reports: reports.map((r) => ({
        type: r.type,
        enabled: r.enabled === 1,
        schedule_cron: r.schedule_cron,
      })),
    });
  },

  configureReport(ctx: ToolContext, args: Record<string, unknown>): string {
    const type = String(args.type ?? "");
    if (type !== "daily" && type !== "weekly") {
      return JSON.stringify({ success: false, message: "type は 'daily' または 'weekly' を指定してください。" });
    }
    if (args.schedule_cron !== undefined && !cron.validate(String(args.schedule_cron))) {
      return JSON.stringify({ success: false, message: "schedule_cron のcron式が不正です。" });
    }

    const updated = upsertReportConfig(ctx.userId, type as ReportType, {
      ...(args.enabled !== undefined ? { enabled: args.enabled === true } : {}),
      ...(args.schedule_cron !== undefined ? { scheduleCron: String(args.schedule_cron) } : {}),
    });

    const typeLabel = type === "daily" ? "日報" : "週報";
    return JSON.stringify({
      success: true,
      message: `${typeLabel}の配信設定を更新しました📋（${updated.enabled === 1 ? "有効" : "無効"} / ${updated.schedule_cron}）`,
    });
  },

  async runBriefingNow(ctx: ToolContext): Promise<string> {
    const config = getBriefingConfig(ctx.userId);
    if (!config) {
      return JSON.stringify({
        success: false,
        message: "朝報がまだ設定されていません。先に configureBriefing で天気の地点やニュースフィードを設定してください。",
      });
    }
    const sent = await runBriefingForUser(ctx.userId);
    return JSON.stringify({
      success: sent,
      message: sent ? "朝報をテスト配信しました🌅" : "朝報の配信に失敗しました。",
    });
  },
};

/** 朝報・日報・週報設定 FunctionModule */
export const briefingFunctions: FunctionModule = {
  declarations,
  handlers,
};
