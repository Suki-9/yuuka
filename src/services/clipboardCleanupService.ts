import cron from "node-cron";
import { deleteExpired } from "../db/clipboardRepo.js";

// ─── クリップボードTTLクリーンアップ（§3.10.3） ──────────────────────────────
// 毎時0分に期限切れエントリを自動削除する。

let task: cron.ScheduledTask | null = null;

export function startClipboardCleanup(): void {
  if (task) return;

  // 起動直後にも一度実行（停止中に期限切れになったエントリの掃除）
  try {
    const removed = deleteExpired();
    if (removed > 0) {
      console.log(`🧹 [Clipboard] 起動時クリーンアップ: 期限切れメモ ${removed} 件を削除しました`);
    }
  } catch (err) {
    console.error("[Clipboard] 起動時クリーンアップに失敗しました:", err);
  }

  task = cron.schedule("0 * * * *", () => {
    try {
      const removed = deleteExpired();
      if (removed > 0) {
        console.log(`🧹 [Clipboard] 期限切れメモ ${removed} 件を削除しました`);
      }
    } catch (err) {
      console.error("[Clipboard] クリーンアップに失敗しました:", err);
    }
  });

  console.log("🧹 クリップボードTTLクリーンアップを開始しました（毎時0分）");
}

export function stopClipboardCleanup(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
