import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { config } from "../config.js";
import { sendToUser, type NotifyTarget } from "./notifier.js";
import {
  listDuePending,
  markSent,
  rescheduleRepeat,
  type ReminderRecord,
} from "../db/reminderRepo.js";
import { listOpenTodosDueWithinAcrossUsers, markDueReminded } from "../db/todoRepo.js";
import { getUnremindedSchedules, markReminded } from "../db/scheduleRepo.js";

// ─── リマインドエンジン（§3.3.2） ────────────────────────────────────────────
//
// 旧 reminderService.ts の置き換え。node-cron で毎分起床し、以下を処理する:
//   1. 時刻指定リマインド: reminders テーブルの trigger_at <= now AND status='pending'
//      を送信。repeat_rule（cron式）があれば次回時刻へ再スケジュール（§3.3.1, §3.3.2）。
//   2. タスク起因リマインド: 期限が24時間以内に迫った未通知ToDoへ自動通知（§3.3.1）。
//   3. スケジュール起因リマインド: Googleカレンダー同期予定のイベント前通知（§3.3.1）。
// 起動時にも一度実行することで、計画外停止中に時刻を過ぎたリマインドを復帰処理する（§10）。
// 時刻はDB既存形式 'YYYY-MM-DD HH:MM:SS'（ローカルタイム）に統一する（reminderRepo.toDbDateTime）。

let task: cron.ScheduledTask | null = null;

/** 処理の多重起動防止フラグ（送信に時間がかかり次の毎分ティックと重なるのを防ぐ） */
let ticking = false;

// ─── 表示用フォーマットヘルパー ──────────────────────────────────────────────

/**
 * DB保存形式（'YYYY-MM-DD HH:MM:SS' / ISO 8601）の日時を通知文向けに整形する。
 * 秒は冗長なため 'YYYY-MM-DD HH:MM' まで、日付のみの場合はそのまま返す。
 */
function formatDisplayDateTime(value: string | null | undefined): string {
  if (!value) return "未設定";
  const v = value.trim().replace("T", " ");
  const m = v.match(/^(\d{4}-\d{2}-\d{2})(?:\s(\d{2}:\d{2}))?/);
  if (!m) return v;
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

/** リマインドレコードから通知送信先を解決する */
function resolveTarget(reminder: ReminderRecord): NotifyTarget | undefined {
  if (reminder.target_type === "channel") {
    if (reminder.target_id) return { type: "channel", id: reminder.target_id };
    // チャンネル指定だがID不明の場合は undefined を返し、
    // notifier 側でユーザー設定の既定送信先（→DM）の順に解決させる
    return undefined;
  }
  return { type: "dm" };
}

// ─── 1. 時刻指定・繰り返しリマインド（§3.3.2） ──────────────────────────────

async function processDueReminders(): Promise<void> {
  // cron用の全ユーザー走査（reminderRepo.listDuePending 側に例外コメントあり）
  const due = listDuePending();

  for (const reminder of due) {
    try {
      const sent = await sendToUser(
        reminder.user_id,
        { content: `⏰ リマインド: ${reminder.message}` },
        resolveTarget(reminder)
      );

      if (!sent) {
        // 送信失敗時は pending のまま残し、次回ティックで再試行する（§10 復帰と同じ経路）
        console.warn(`⚠️ リマインド送信失敗のため再試行します (reminder #${reminder.id}, user: ${reminder.user_id})`);
        continue;
      }

      if (reminder.repeat_rule) {
        // 繰り返しリマインド: cron式から次回送信時刻を計算して再スケジュール（§3.3.2）
        try {
          const next = CronExpressionParser.parse(reminder.repeat_rule, {
            currentDate: new Date(),
          })
            .next()
            .toDate();
          rescheduleRepeat(reminder.id, next);
          console.log(`🔁 繰り返しリマインド再設定: #${reminder.id} → ${formatDisplayDateTime(next.toISOString())} (user: ${reminder.user_id})`);
        } catch (err) {
          // cron式が壊れている場合は無限再送を防ぐため送信済みで打ち切る
          console.error(`❌ repeat_rule の解釈に失敗したため単発扱いにします (reminder #${reminder.id}, rule: ${reminder.repeat_rule}):`, err);
          markSent(reminder.id);
        }
      } else {
        markSent(reminder.id);
      }

      console.log(`🔔 リマインド送信: #${reminder.id} (user: ${reminder.user_id}, source: ${reminder.source})`);
    } catch (err) {
      console.error(`❌ リマインド処理エラー (reminder #${reminder.id}):`, err);
    }
  }
}

// ─── 2. タスク起因リマインド（§3.3.1） ──────────────────────────────────────

async function processTodoDueReminders(): Promise<void> {
  // cron用の全ユーザー走査: 期限が24時間以内に迫った未通知のToDoを抽出する
  const todos = listOpenTodosDueWithinAcrossUsers(24);

  for (const todo of todos) {
    try {
      if (todo.due_reminded) continue; // 二重送信防止（リポジトリ側フィルタの保険）

      const content =
        `⏰ ToDoの期限が近づいています: 「${todo.title}」 (#${todo.id})\n` +
        `期限: ${formatDisplayDateTime(todo.due_date)}`;

      // 送信先はユーザー設定の既定送信先に従う（notifier 側で解決）
      const sent = await sendToUser(todo.user_id, { content });
      if (sent) {
        markDueReminded(todo.id);
        console.log(`🔔 ToDo期限リマインド送信: todo #${todo.id} (user: ${todo.user_id})`);
      } else {
        console.warn(`⚠️ ToDo期限リマインド送信失敗のため再試行します (todo #${todo.id}, user: ${todo.user_id})`);
      }
    } catch (err) {
      console.error(`❌ ToDo期限リマインド処理エラー (todo #${todo.id}):`, err);
    }
  }
}

// ─── 3. スケジュール起因リマインド（§3.3.1） ────────────────────────────────

async function processScheduleReminders(): Promise<void> {
  // cron用の全ユーザー走査: 通知前時間（remind_before_minutes）を迎えた未通知予定を抽出する
  // （旧 reminderService.ts の bot_id スコープ処理を user_id スコープへ移植）
  const schedules = getUnremindedSchedules();

  for (const schedule of schedules) {
    try {
      const content =
        `⏰ まもなく予定の時間です: 「${schedule.title}」\n` +
        `開始: ${formatDisplayDateTime(schedule.start_at)}`;

      // 送信先はユーザー設定の既定送信先に従う（notifier 側で解決）
      const sent = await sendToUser(schedule.user_id, { content });
      if (sent) {
        markReminded(schedule.id);
        console.log(`🔔 予定リマインド送信: schedule #${schedule.id} (user: ${schedule.user_id})`);
      } else {
        console.warn(`⚠️ 予定リマインド送信失敗のため再試行します (schedule #${schedule.id}, user: ${schedule.user_id})`);
      }
    } catch (err) {
      console.error(`❌ 予定リマインド処理エラー (schedule #${schedule.id}):`, err);
    }
  }
}

// ─── ティック実行 ────────────────────────────────────────────────────────────

async function runTick(): Promise<void> {
  if (ticking) return; // 前回の処理が長引いている場合はスキップ（多重送信防止）
  ticking = true;
  try {
    await processDueReminders();
    await processTodoDueReminders();
    await processScheduleReminders();
  } catch (err) {
    console.error("❌ リマインドエンジンのティック処理でエラーが発生しました:", err);
  } finally {
    ticking = false;
  }
}

// ─── 開始 / 停止 ─────────────────────────────────────────────────────────────

/**
 * リマインドエンジンを開始する（§3.3.2）。
 * 毎分（config.reminderCron）の定期実行に加え、起動直後にも一度実行して
 * 計画外停止中に時刻を過ぎた pending リマインドを復帰処理する（§10）。
 */
export function startReminderEngine(): void {
  if (task) {
    console.log("⏰ リマインドエンジンは既に開始されています");
    return;
  }

  task = cron.schedule(config.reminderCron, () => {
    void runTick();
  });

  console.log("⏰ リマインドエンジン開始");

  // 起動時の復帰処理（§10: trigger_at <= now AND status='pending' を即時処理）
  void runTick();
}

/** リマインドエンジンを停止する */
export function stopReminderEngine(): void {
  if (task) {
    task.stop();
    task = null;
    console.log("⏰ リマインドエンジン停止");
  }
}
