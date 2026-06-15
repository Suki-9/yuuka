import { getDb } from "./database.js";

// ─── 朝報（天気・ニュース定期配信）設定リポジトリ（§3.9.3） ───────────────────

export interface BriefingConfigRecord {
  user_id: string;
  bot_id: string;
  enabled: number;
  schedule_cron: string;
  target_type: "dm" | "channel";
  target_id: string | null;
  weather_lat: number | null;
  weather_lng: number | null;
  location_name: string | null;
  news_feeds: string; // JSON string[]
  news_keywords: string; // JSON string[]
  updated_at: string;
}

export interface BriefingConfigInput {
  enabled?: boolean;
  scheduleCron?: string;
  targetType?: "dm" | "channel";
  targetId?: string | null;
  weatherLat?: number | null;
  weatherLng?: number | null;
  locationName?: string | null;
  newsFeeds?: string[];
  newsKeywords?: string[];
}

export function getBriefingConfig(userId: string, botId: string): BriefingConfigRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM briefing_configs WHERE user_id = ? AND bot_id = ?")
    .get(userId, botId) as BriefingConfigRecord | undefined;
}

export function upsertBriefingConfig(
  userId: string,
  botId: string,
  input: BriefingConfigInput
): BriefingConfigRecord {
  const db = getDb();
  const current = getBriefingConfig(userId, botId);

  db.prepare(
    `INSERT INTO briefing_configs
       (user_id, bot_id, enabled, schedule_cron, target_type, target_id, weather_lat, weather_lng, location_name, news_feeds, news_keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, bot_id) DO UPDATE SET
       enabled = excluded.enabled,
       schedule_cron = excluded.schedule_cron,
       target_type = excluded.target_type,
       target_id = excluded.target_id,
       weather_lat = excluded.weather_lat,
       weather_lng = excluded.weather_lng,
       location_name = excluded.location_name,
       news_feeds = excluded.news_feeds,
       news_keywords = excluded.news_keywords,
       updated_at = datetime('now', 'localtime')`
  ).run(
    userId,
    botId,
    (input.enabled !== undefined ? input.enabled : current ? current.enabled === 1 : false) ? 1 : 0,
    input.scheduleCron ?? current?.schedule_cron ?? "0 7 * * *",
    input.targetType ?? current?.target_type ?? "dm",
    input.targetId !== undefined ? input.targetId : current?.target_id ?? null,
    input.weatherLat !== undefined ? input.weatherLat : current?.weather_lat ?? null,
    input.weatherLng !== undefined ? input.weatherLng : current?.weather_lng ?? null,
    input.locationName !== undefined ? input.locationName : current?.location_name ?? null,
    JSON.stringify(input.newsFeeds ?? parseJsonArray(current?.news_feeds)),
    JSON.stringify(input.newsKeywords ?? parseJsonArray(current?.news_keywords))
  );

  return getBriefingConfig(userId, botId)!;
}

/** 有効な朝報設定の全件取得（cron用・全ユーザー横断の例外クエリ） */
export function listEnabledBriefingConfigsAcrossUsers(): BriefingConfigRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM briefing_configs WHERE enabled = 1").all() as BriefingConfigRecord[];
}

export function parseJsonArray(json: string | undefined | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
