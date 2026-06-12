import cron from "node-cron";
import Parser from "rss-parser";
import { EmbedBuilder } from "discord.js";
import {
  listEnabledBriefingConfigsAcrossUsers,
  getBriefingConfig,
  parseJsonArray,
  type BriefingConfigRecord,
} from "../db/briefingConfigRepo.js";
import { generateAuxText } from "./llmClient.js";
import { sendToUser } from "./notifier.js";
import { cronMatchesNow } from "./reportService.js";

// ─── 朝報: 天気・ニュース定期配信（§3.9） ────────────────────────────────────
// 天気: Open-Meteo API（無料枠・APIキー不要）
// ニュース: rss-parser でユーザー登録フィードを取得し、LLMが3〜5件に要約する。

let task: cron.ScheduledTask | null = null;

const rssParser = new Parser({ timeout: 10000 });

/** WMO Weather interpretation codes → 日本語天気名（Open-Meteo準拠） */
const WEATHER_CODE_MAP: Record<number, string> = {
  0: "快晴",
  1: "晴れ",
  2: "一部曇り",
  3: "曇り",
  45: "霧",
  48: "着氷性の霧",
  51: "弱い霧雨",
  53: "霧雨",
  55: "強い霧雨",
  56: "弱い着氷性霧雨",
  57: "着氷性霧雨",
  61: "小雨",
  63: "雨",
  65: "大雨",
  66: "弱い着氷性の雨",
  67: "着氷性の雨",
  71: "小雪",
  73: "雪",
  75: "大雪",
  77: "霧雪",
  80: "にわか雨（弱）",
  81: "にわか雨",
  82: "激しいにわか雨",
  85: "にわか雪（弱）",
  86: "にわか雪",
  95: "雷雨",
  96: "雷雨（弱い雹）",
  99: "雷雨（強い雹）",
};

function weatherCodeToLabel(code: number): string {
  return WEATHER_CODE_MAP[code] ?? `不明(${code})`;
}

interface DailyWeather {
  date: string;
  label: string;
  tempMax: number;
  tempMin: number;
  precipitationProbability: number | null;
}

/**
 * Open-Meteo から当日・翌日の天気を取得する（§3.9.2）
 */
async function fetchWeather(lat: number, lng: number): Promise<DailyWeather[] | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Asia%2FTokyo&forecast_days=2`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: (number | null)[];
      };
    };
    const daily = json.daily;
    if (!daily?.time) return null;

    return daily.time.map((date, i) => ({
      date,
      label: weatherCodeToLabel(daily.weather_code?.[i] ?? -1),
      tempMax: daily.temperature_2m_max?.[i] ?? NaN,
      tempMin: daily.temperature_2m_min?.[i] ?? NaN,
      precipitationProbability: daily.precipitation_probability_max?.[i] ?? null,
    }));
  } catch (err) {
    console.error("[Briefing] 天気の取得に失敗しました:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface NewsItem {
  title: string;
  link: string;
  source: string;
}

/**
 * RSSフィードからニュースヘッドラインを取得する（個別フィードの失敗は無視 §3.9.2）
 */
async function fetchNewsItems(feedUrls: string[], keywords: string[]): Promise<NewsItem[]> {
  const items: NewsItem[] = [];

  for (const url of feedUrls.slice(0, 10)) {
    try {
      const feed = await rssParser.parseURL(url);
      const source = feed.title || new URL(url).hostname;
      for (const entry of (feed.items || []).slice(0, 10)) {
        if (!entry.title) continue;
        items.push({
          title: entry.title,
          link: entry.link || "",
          source,
        });
      }
    } catch (err) {
      console.warn(`[Briefing] RSSフィードの取得に失敗しました (${url}):`, (err as Error).message);
    }
  }

  // キーワードフィルタ（指定がある場合のみ）
  if (keywords.length > 0) {
    const filtered = items.filter((item) => keywords.some((k) => item.title.includes(k)));
    // フィルタで全滅した場合はフィルタなしの先頭数件を返す（空の朝報を防ぐ）
    return filtered.length > 0 ? filtered : items.slice(0, 5);
  }
  return items;
}

/**
 * 朝報を生成して配信する（手動テスト配信からも呼ばれる）
 */
export async function runBriefingForUser(userId: string): Promise<boolean> {
  const config = getBriefingConfig(userId);
  if (!config) return false;

  const embed = new EmbedBuilder()
    .setTitle("🌅 おはようございます！今日の朝報です")
    .setColor(0x00b0f4) // 天気・朝報スカイブルー（§3.0.2）
    .setTimestamp();

  let hasContent = false;

  // ── 天気（§3.9.2） ──
  if (config.weather_lat != null && config.weather_lng != null) {
    const weather = await fetchWeather(config.weather_lat, config.weather_lng);
    if (weather && weather.length > 0) {
      const location = config.location_name || `${config.weather_lat}, ${config.weather_lng}`;
      const lines = weather.map((w, i) => {
        const dayLabel = i === 0 ? "今日" : "明日";
        const rain =
          w.precipitationProbability != null ? ` / 降水確率 ${w.precipitationProbability}%` : "";
        return `**${dayLabel}**: ${w.label}　${Math.round(w.tempMin)}℃〜${Math.round(w.tempMax)}℃${rain}`;
      });
      embed.addFields({ name: `🌤️ ${location} の天気`, value: lines.join("\n"), inline: false });
      hasContent = true;
    } else {
      embed.addFields({ name: "🌤️ 天気", value: "天気情報の取得に失敗しました。", inline: false });
    }
  }

  // ── ニュース（§3.9.2: LLMが3〜5件に要約） ──
  const feeds = parseJsonArray(config.news_feeds);
  if (feeds.length > 0) {
    const keywords = parseJsonArray(config.news_keywords);
    const items = await fetchNewsItems(feeds, keywords);

    if (items.length > 0) {
      let newsText: string | null = null;
      try {
        const source = items
          .slice(0, 30)
          .map((i) => `- [${i.source}] ${i.title}`)
          .join("\n");
        newsText = await generateAuxText(
          userId,
          `以下はRSSフィードから取得した今朝のニュースヘッドライン一覧です。` +
            `重要・有用なものを3〜5件選び、それぞれ1行（「・見出し — ひとこと補足」形式）で日本語に要約してください。` +
            `要約のみを出力してください。\n\n${source}`
        );
      } catch (err) {
        console.warn(`[Briefing] ニュース要約に失敗しました (user: ${userId}):`, err);
      }

      // フォールバック: タイトル列挙（§3.9 LLM不可時）
      const fallback = items
        .slice(0, 5)
        .map((i) => `・${i.title}`)
        .join("\n");

      embed.addFields({
        name: "📰 今朝のニュース",
        value: (newsText?.trim() || fallback).slice(0, 1024),
        inline: false,
      });
      hasContent = true;
    } else {
      embed.addFields({ name: "📰 ニュース", value: "フィードから記事を取得できませんでした。", inline: false });
    }
  }

  if (!hasContent) {
    embed.setDescription(
      "朝報に表示する内容がまだ設定されていません。天気の地点（緯度経度）やニュースのRSSフィードを設定してください。"
    );
  }

  embed.setFooter({ text: "データ提供: Open-Meteo / 登録RSSフィード" });

  return sendToUser(
    userId,
    { embeds: [embed] },
    { type: config.target_type, id: config.target_id ?? undefined }
  );
}

async function tick(): Promise<void> {
  const now = new Date();
  let configs: BriefingConfigRecord[];
  try {
    configs = listEnabledBriefingConfigsAcrossUsers();
  } catch (err) {
    console.error("[Briefing] 配信設定の取得に失敗しました:", err);
    return;
  }

  for (const conf of configs) {
    if (!cronMatchesNow(conf.schedule_cron, now)) continue;
    console.log(`🌅 [Briefing] 朝報を配信します (user: ${conf.user_id})`);
    try {
      await runBriefingForUser(conf.user_id);
    } catch (err) {
      console.error(`[Briefing] 朝報配信に失敗しました (user: ${conf.user_id}):`, err);
    }
  }
}

export function startBriefingService(): void {
  if (task) return;
  task = cron.schedule("* * * * *", () => {
    void tick();
  });
  console.log("🌅 朝報（天気・ニュース）サービスを開始しました（毎分cron判定）");
}

export function stopBriefingService(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
