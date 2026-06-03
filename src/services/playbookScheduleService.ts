import cron from "node-cron";
import { getDb } from "../db/database.js";
import { findPlaybooks } from "./playbookService.js";
import { processMessage } from "../gemini.js";

export interface PlaybookSchedule {
  id: number;
  bot_id: string;
  playbook_name: string;
  cron_expression: string;
  description: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlaybookRun {
  id: number;
  schedule_id: number;
  bot_id: string;
  playbook_name: string;
  status: "running" | "success" | "failed";
  output: string;
  started_at: string;
  finished_at: string | null;
}

// botId+playbookName → ScheduledTask のマップ
const activeTasks = new Map<string, cron.ScheduledTask>();

function taskKey(botId: string, playbookName: string): string {
  return `${botId}::${playbookName}`;
}

function rowToSchedule(row: any): PlaybookSchedule {
  return {
    ...row,
    enabled: row.enabled === 1,
  };
}

// ── CRUD ──────────────────────────────────────────────

export function listSchedules(botId: string): PlaybookSchedule[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM playbook_schedules WHERE bot_id = ? ORDER BY created_at DESC`
    )
    .all(botId) as any[];
  return rows.map(rowToSchedule);
}

export function getScheduleById(id: number): PlaybookSchedule | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM playbook_schedules WHERE id = ?`)
    .get(id) as any;
  return row ? rowToSchedule(row) : null;
}

export function upsertSchedule(
  botId: string,
  playbookName: string,
  cronExpression: string,
  description: string,
  enabled: boolean
): { success: boolean; message: string; schedule?: PlaybookSchedule } {
  if (!cron.validate(cronExpression)) {
    return { success: false, message: "無効なcron式です。" };
  }

  const playbooks = findPlaybooks(botId);
  if (!playbooks.some((p) => p.name === playbookName)) {
    return {
      success: false,
      message: `Playbook「${playbookName}」が見つかりません。`,
    };
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO playbook_schedules (bot_id, playbook_name, cron_expression, description, enabled)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(bot_id, playbook_name) DO UPDATE SET
       cron_expression = excluded.cron_expression,
       description = excluded.description,
       enabled = excluded.enabled,
       updated_at = datetime('now', 'localtime')`
  ).run(botId, playbookName, cronExpression, description, enabled ? 1 : 0);

  const row = db
    .prepare(
      `SELECT * FROM playbook_schedules WHERE bot_id = ? AND playbook_name = ?`
    )
    .get(botId, playbookName) as any;
  const schedule = rowToSchedule(row);

  // cron再登録
  registerCronJob(schedule);

  return {
    success: true,
    message: `スケジュール「${playbookName}」を保存しました。`,
    schedule,
  };
}

export function toggleSchedule(
  id: number,
  enabled: boolean
): { success: boolean; message: string } {
  const db = getDb();
  const schedule = getScheduleById(id);
  if (!schedule) return { success: false, message: "スケジュールが見つかりません。" };

  db.prepare(
    `UPDATE playbook_schedules SET enabled = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(enabled ? 1 : 0, id);

  if (enabled) {
    registerCronJob({ ...schedule, enabled: true });
  } else {
    stopCronJob(schedule.bot_id, schedule.playbook_name);
  }

  return {
    success: true,
    message: enabled ? "スケジュールを有効化しました。" : "スケジュールを無効化しました。",
  };
}

export function deleteSchedule(
  botId: string,
  id: number
): { success: boolean; message: string } {
  const db = getDb();
  const schedule = getScheduleById(id);
  if (!schedule || schedule.bot_id !== botId) {
    return { success: false, message: "スケジュールが見つかりません。" };
  }

  stopCronJob(schedule.bot_id, schedule.playbook_name);
  db.prepare(`DELETE FROM playbook_schedules WHERE id = ?`).run(id);
  return { success: true, message: "スケジュールを削除しました。" };
}

// ── 実行履歴 ─────────────────────────────────────────

export function listRuns(
  botId: string,
  scheduleId?: number,
  limit = 50
): PlaybookRun[] {
  const db = getDb();
  if (scheduleId != null) {
    return db
      .prepare(
        `SELECT * FROM playbook_runs WHERE bot_id = ? AND schedule_id = ?
         ORDER BY started_at DESC LIMIT ?`
      )
      .all(botId, scheduleId, limit) as PlaybookRun[];
  }
  return db
    .prepare(
      `SELECT * FROM playbook_runs WHERE bot_id = ?
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(botId, limit) as PlaybookRun[];
}

function createRun(scheduleId: number, botId: string, playbookName: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO playbook_runs (schedule_id, bot_id, playbook_name, status)
       VALUES (?, ?, ?, 'running')`
    )
    .run(scheduleId, botId, playbookName);
  return result.lastInsertRowid as number;
}

function finishRun(
  runId: number,
  status: "success" | "failed",
  output: string
): void {
  const db = getDb();
  db.prepare(
    `UPDATE playbook_runs SET status = ?, output = ?, finished_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(status, output, runId);
}

function updateLastRun(scheduleId: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE playbook_schedules SET last_run_at = datetime('now', 'localtime'),
     updated_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(scheduleId);
}

// ── cron 管理 ─────────────────────────────────────────

function stopCronJob(botId: string, playbookName: string): void {
  const key = taskKey(botId, playbookName);
  const existing = activeTasks.get(key);
  if (existing) {
    existing.stop();
    activeTasks.delete(key);
  }
}

function registerCronJob(schedule: PlaybookSchedule): void {
  stopCronJob(schedule.bot_id, schedule.playbook_name);
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron_expression)) return;

  const key = taskKey(schedule.bot_id, schedule.playbook_name);
  const task = cron.schedule(schedule.cron_expression, async () => {
    await executePlaybook(schedule);
  });
  activeTasks.set(key, task);
}

async function executePlaybook(schedule: PlaybookSchedule): Promise<void> {
  const runId = createRun(schedule.id, schedule.bot_id, schedule.playbook_name);
  console.log(
    `▶️ Playbook スケジュール実行開始: ${schedule.playbook_name} (bot: ${schedule.bot_id})`
  );

  try {
    // Playbookの内容を取得
    const playbooks = findPlaybooks(schedule.bot_id, schedule.playbook_name);
    const playbook = playbooks.find((p) => p.name === schedule.playbook_name);
    if (!playbook) {
      finishRun(runId, "failed", `Playbook「${schedule.playbook_name}」が見つかりませんでした。`);
      return;
    }

    const prompt =
      `【定期実行】以下の手順書を実行してください。\n\n` +
      `手順書名: ${playbook.title}\n` +
      `---\n${playbook.steps}`;

    const result = await processMessage(schedule.bot_id, { text: prompt });
    finishRun(runId, "success", result.text);
    updateLastRun(schedule.id);
    console.log(
      `✅ Playbook スケジュール実行完了: ${schedule.playbook_name} (bot: ${schedule.bot_id})`
    );
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    finishRun(runId, "failed", errMsg);
    updateLastRun(schedule.id);
    console.error(
      `❌ Playbook スケジュール実行失敗: ${schedule.playbook_name} (bot: ${schedule.bot_id})`,
      err
    );
  }
}

// ── 起動時の全スケジュール読み込み ──────────────────────

export function startPlaybookScheduleService(): void {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM playbook_schedules WHERE enabled = 1`)
    .all() as any[];

  let count = 0;
  for (const row of rows) {
    const schedule = rowToSchedule(row);
    if (cron.validate(schedule.cron_expression)) {
      registerCronJob(schedule);
      count++;
    }
  }
  console.log(`📅 Playbookスケジュールサービス開始 (${count}件のスケジュールを登録)`);
}

export function stopPlaybookScheduleService(): void {
  for (const task of activeTasks.values()) {
    task.stop();
  }
  activeTasks.clear();
  console.log("📅 Playbookスケジュールサービス停止");
}
