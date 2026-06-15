import { getDb } from "./database.js";

// ─── 日報・週報の配信設定リポジトリ（§3.8.4） ────────────────────────────────

export type ReportType = "daily" | "weekly";

export interface ReportConfigRecord {
  id: number;
  user_id: string;
  bot_id: string;
  type: ReportType;
  enabled: number;
  schedule_cron: string;
  target_type: "dm" | "channel";
  target_id: string | null;
  updated_at: string;
}

export interface ReportConfigInput {
  enabled?: boolean;
  scheduleCron?: string;
  targetType?: "dm" | "channel";
  targetId?: string | null;
}

/** デフォルトcron（日報: 毎日21時 / 週報: 毎週日曜21時） */
export const DEFAULT_REPORT_CRON: Record<ReportType, string> = {
  daily: "0 21 * * *",
  weekly: "0 21 * * 0",
};

export function upsertReportConfig(
  userId: string,
  botId: string,
  type: ReportType,
  input: ReportConfigInput
): ReportConfigRecord {
  const db = getDb();
  const current = getReportConfig(userId, botId, type);

  db.prepare(
    `INSERT INTO report_configs (user_id, bot_id, type, enabled, schedule_cron, target_type, target_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, bot_id, type) DO UPDATE SET
       enabled = excluded.enabled,
       schedule_cron = excluded.schedule_cron,
       target_type = excluded.target_type,
       target_id = excluded.target_id,
       updated_at = datetime('now', 'localtime')`
  ).run(
    userId,
    botId,
    type,
    (input.enabled !== undefined ? input.enabled : current ? current.enabled === 1 : false) ? 1 : 0,
    input.scheduleCron ?? current?.schedule_cron ?? DEFAULT_REPORT_CRON[type],
    input.targetType ?? current?.target_type ?? "dm",
    input.targetId !== undefined ? input.targetId : current?.target_id ?? null
  );

  return getReportConfig(userId, botId, type)!;
}

export function getReportConfig(userId: string, botId: string, type: ReportType): ReportConfigRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM report_configs WHERE user_id = ? AND bot_id = ? AND type = ?")
    .get(userId, botId, type) as ReportConfigRecord | undefined;
}

export function getReportConfigs(userId: string, botId: string): ReportConfigRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM report_configs WHERE user_id = ? AND bot_id = ? ORDER BY type ASC")
    .all(userId, botId) as ReportConfigRecord[];
}

/** 有効な配信設定の全件取得（cron用・全ユーザー横断の例外クエリ） */
export function listEnabledReportConfigsAcrossUsers(): ReportConfigRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM report_configs WHERE enabled = 1")
    .all() as ReportConfigRecord[];
}
