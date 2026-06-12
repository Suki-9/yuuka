import cron from "node-cron";
import { getDb } from "../db/database.js";
import { findPlaybooks } from "./playbookService.js";
import { processMessage } from "../gemini.js";
import { sendToUser } from "./notifier.js";

// ─── マクロ（Playbook）定期実行スケジュール（§3.6） ──────────────────────────
// user_id スコープで管理し、実行は本人のGemini APIキー・本人のデータコンテキストで行う。

export interface PlaybookSchedule {
  id: number;
  user_id: string;
  bot_id: string; // 実行結果の通知に使うBotインスタンス
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
  user_id: string;
  playbook_name: string;
  status: "running" | "success" | "failed";
  output: string;
  started_at: string;
  finished_at: string | null;
}

// userId+playbookName → ScheduledTask のマップ
const activeTasks = new Map<string, cron.ScheduledTask>();

function taskKey(userId: string, playbookName: string): string {
  return `${userId}::${playbookName}`;
}

function rowToSchedule(row: any): PlaybookSchedule {
  return {
    ...row,
    enabled: row.enabled === 1,
  };
}

// ── CRUD ──────────────────────────────────────────────

export function listSchedules(userId: string): PlaybookSchedule[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM playbook_schedules WHERE user_id = ? ORDER BY created_at DESC`)
    .all(userId) as any[];
  return rows.map(rowToSchedule);
}

export function getScheduleById(id: number): PlaybookSchedule | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM playbook_schedules WHERE id = ?`).get(id) as any;
  return row ? rowToSchedule(row) : null;
}

export function upsertSchedule(
  userId: string,
  playbookName: string,
  cronExpression: string,
  description: string,
  enabled: boolean,
  botId: string = "system_default"
): { success: boolean; message: string; schedule?: PlaybookSchedule } {
  if (!cron.validate(cronExpression)) {
    return { success: false, message: "無効なcron式です。" };
  }

  const playbooks = findPlaybooks(userId);
  if (!playbooks.some((p) => p.name === playbookName)) {
    return {
      success: false,
      message: `マクロ「${playbookName}」が見つかりません。`,
    };
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO playbook_schedules (user_id, bot_id, playbook_name, cron_expression, description, enabled)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, playbook_name) DO UPDATE SET
       bot_id = excluded.bot_id,
       cron_expression = excluded.cron_expression,
       description = excluded.description,
       enabled = excluded.enabled,
       updated_at = datetime('now', 'localtime')`
  ).run(userId, botId, playbookName, cronExpression, description, enabled ? 1 : 0);

  const row = db
    .prepare(`SELECT * FROM playbook_schedules WHERE user_id = ? AND playbook_name = ?`)
    .get(userId, playbookName) as any;
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
  userId: string,
  id: number,
  enabled: boolean
): { success: boolean; message: string } {
  const db = getDb();
  const schedule = getScheduleById(id);
  if (!schedule || schedule.user_id !== userId) {
    return { success: false, message: "スケジュールが見つかりません。" };
  }

  db.prepare(
    `UPDATE playbook_schedules SET enabled = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(enabled ? 1 : 0, id);

  if (enabled) {
    registerCronJob({ ...schedule, enabled: true });
  } else {
    stopCronJob(schedule.user_id, schedule.playbook_name);
  }

  return {
    success: true,
    message: enabled ? "スケジュールを有効化しました。" : "スケジュールを無効化しました。",
  };
}

export function deleteSchedule(
  userId: string,
  id: number
): { success: boolean; message: string } {
  const db = getDb();
  const schedule = getScheduleById(id);
  if (!schedule || schedule.user_id !== userId) {
    return { success: false, message: "スケジュールが見つかりません。" };
  }

  stopCronJob(schedule.user_id, schedule.playbook_name);
  db.prepare(`DELETE FROM playbook_schedules WHERE id = ?`).run(id);
  return { success: true, message: "スケジュールを削除しました。" };
}

// ── 実行履歴 ─────────────────────────────────────────

export function listRuns(userId: string, scheduleId?: number, limit = 50): PlaybookRun[] {
  const db = getDb();
  if (scheduleId != null) {
    return db
      .prepare(
        `SELECT * FROM playbook_runs WHERE user_id = ? AND schedule_id = ?
         ORDER BY started_at DESC LIMIT ?`
      )
      .all(userId, scheduleId, limit) as PlaybookRun[];
  }
  return db
    .prepare(
      `SELECT * FROM playbook_runs WHERE user_id = ?
       ORDER BY started_at DESC LIMIT ?`
    )
    .all(userId, limit) as PlaybookRun[];
}

function createRun(scheduleId: number, userId: string, playbookName: string): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO playbook_runs (schedule_id, user_id, playbook_name, status)
       VALUES (?, ?, ?, 'running')`
    )
    .run(scheduleId, userId, playbookName);
  return result.lastInsertRowid as number;
}

function finishRun(runId: number, status: "success" | "failed", output: string): void {
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

function stopCronJob(userId: string, playbookName: string): void {
  const key = taskKey(userId, playbookName);
  const existing = activeTasks.get(key);
  if (existing) {
    existing.stop();
    activeTasks.delete(key);
  }
}

function registerCronJob(schedule: PlaybookSchedule): void {
  stopCronJob(schedule.user_id, schedule.playbook_name);
  if (!schedule.enabled) return;
  if (!cron.validate(schedule.cron_expression)) return;

  const key = taskKey(schedule.user_id, schedule.playbook_name);
  const task = cron.schedule(schedule.cron_expression, () => {
    // executePlaybook 内部の try/catch から漏れた例外（createRun 等のDBエラー）が
    // 未捕捉の Promise 拒否にならないようここでも捕捉する
    executePlaybook(schedule).catch((err) => {
      console.error(
        `❌ マクロ定期実行で予期しないエラー: ${schedule.playbook_name} (user: ${schedule.user_id})`,
        err
      );
    });
  });
  activeTasks.set(key, task);
}

async function executePlaybook(schedule: PlaybookSchedule): Promise<void> {
  const runId = createRun(schedule.id, schedule.user_id, schedule.playbook_name);
  console.log(
    `▶️ マクロ定期実行開始: ${schedule.playbook_name} (user: ${schedule.user_id})`
  );

  try {
    // マクロの内容を取得
    const playbooks = findPlaybooks(schedule.user_id, schedule.playbook_name);
    const playbook = playbooks.find((p) => p.name === schedule.playbook_name);
    if (!playbook) {
      finishRun(runId, "failed", `マクロ「${schedule.playbook_name}」が見つかりませんでした。`);
      return;
    }

    const prompt =
      `【定期実行】以下のマクロ（手順書）を実行してください。\n\n` +
      `マクロ名: ${playbook.title}\n` +
      `---\n${playbook.steps}`;

    const result = await processMessage(schedule.bot_id, schedule.user_id, { text: prompt });
    finishRun(runId, "success", result.text);
    updateLastRun(schedule.id);

    // 実行結果をユーザーへ通知する
    await sendToUser(schedule.user_id, {
      content: `📋 マクロ「**${playbook.title}**」の定期実行が完了しました。\n\n${result.text.slice(0, 1700)}`,
      embeds: result.embeds,
      files: result.files,
    });

    console.log(
      `✅ マクロ定期実行完了: ${schedule.playbook_name} (user: ${schedule.user_id})`
    );
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    finishRun(runId, "failed", errMsg);
    updateLastRun(schedule.id);

    await sendToUser(schedule.user_id, {
      content: `⚠️ マクロ「${schedule.playbook_name}」の定期実行に失敗しました: ${errMsg.slice(0, 500)}`,
    }).catch(() => {});

    console.error(
      `❌ マクロ定期実行失敗: ${schedule.playbook_name} (user: ${schedule.user_id})`,
      err
    );
  }
}

// ── 起動時の全スケジュール読み込み ──────────────────────

export function startPlaybookScheduleService(): void {
  const db = getDb();
  // 起動時の全件読み込み（cron用・全ユーザー横断の例外クエリ）
  const rows = db.prepare(`SELECT * FROM playbook_schedules WHERE enabled = 1`).all() as any[];

  let count = 0;
  for (const row of rows) {
    const schedule = rowToSchedule(row);
    if (cron.validate(schedule.cron_expression)) {
      registerCronJob(schedule);
      count++;
    }
  }
  console.log(`📅 マクロ（Playbook）スケジュールサービス開始 (${count}件のスケジュールを登録)`);
}

export function stopPlaybookScheduleService(): void {
  for (const task of activeTasks.values()) {
    task.stop();
  }
  activeTasks.clear();
  console.log("📅 マクロ（Playbook）スケジュールサービス停止");
}
