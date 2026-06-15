import cron from "node-cron";
import { listBirthdayContactsForDate, markBirthdayReminded } from "../db/contactRepo.js";
import { sendToUser } from "./notifier.js";

// ─── 誕生日リマインド（§3.11.2） ─────────────────────────────────────────────
// 毎朝8時に「翌日が誕生日」の連絡先を検出し、登録ユーザーへ通知する。
// birthday_reminded_year により同一年の重複通知を防止する。

let task: cron.ScheduledTask | null = null;

/** 'MM-DD' 形式へ変換 */
function toMonthDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function tick(): Promise<void> {
  try {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const monthDay = toMonthDay(tomorrow);
    const currentYear = new Date().getFullYear();

    const contacts = listBirthdayContactsForDate(monthDay, currentYear);
    for (const contact of contacts) {
      // 年齢計算（YYYY-MM-DD 形式で年が分かる場合のみ）
      let ageNote = "";
      const yearMatch = contact.birthday?.match(/^(\d{4})-/);
      if (yearMatch) {
        const age = tomorrow.getFullYear() - parseInt(yearMatch[1], 10);
        if (age > 0 && age < 130) ageNote = `（${age}歳になります）`;
      }

      const relationship = contact.relationship ? `（${contact.relationship}）` : "";
      const sent = await sendToUser(
        contact.user_id,
        {
          content: `🎂 明日 (${monthDay.replace("-", "/")}) は **${contact.name}**さん${relationship}の誕生日です！${ageNote}\nお祝いの準備はいかがですか？`,
        },
        undefined,
        contact.bot_id
      );

      if (sent) {
        markBirthdayReminded(contact.id, currentYear);
        console.log(`🎂 [Birthday] ${contact.user_id} へ ${contact.name} さんの誕生日リマインドを送信しました`);
      }
      // 送信失敗時はマークせず翌日のtickで再試行する
    }
  } catch (err) {
    console.error("[Birthday] 誕生日リマインド処理に失敗しました:", err);
  }
}

export function startBirthdayReminderService(): void {
  if (task) return;
  task = cron.schedule("0 8 * * *", () => {
    void tick();
  });
  console.log("🎂 誕生日リマインドサービスを開始しました（毎朝8時）");
}

export function stopBirthdayReminderService(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
