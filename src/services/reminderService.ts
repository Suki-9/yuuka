import cron from "node-cron";
import { Client } from "discord.js";
import { getUnremindedSchedules, markReminded } from "../db/scheduleRepo.js";
import { buildReminderEmbed } from "../utils/embeds.js";
import { config } from "../config.js";
import { getBotClientForUser } from "../bot.js";

let task: cron.ScheduledTask | null = null;

/**
 * リマインダーサービスを開始する。
 * 1分ごとに未通知のスケジュールをチェックし、時間が来たらDMで通知する。
 */
export function startReminderService(): void {
  task = cron.schedule(config.reminderCron, async () => {
    try {
      const schedules = getUnremindedSchedules();

      for (const schedule of schedules) {
        try {
          const botClient = getBotClientForUser(schedule.user_id);
          const user = await botClient.users.fetch(schedule.user_id);
          const embed = buildReminderEmbed(schedule);
          await user.send({ embeds: [embed] });
          markReminded(schedule.id);
          console.log(`🔔 リマインド送信: ${schedule.title} → ${schedule.user_id}`);
        } catch (err) {
          console.error(`リマインド送信失敗 (schedule #${schedule.id}):`, err);
        }
      }
    } catch (err) {
      console.error("リマインダーチェックエラー:", err);
    }
  });

  console.log("⏰ リマインダーサービス開始");
}

export function stopReminderService(): void {
  if (task) {
    task.stop();
    task = null;
    console.log("⏰ リマインダーサービス停止");
  }
}
