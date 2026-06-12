import { runMigrations } from "./db/migrations.js";
import { startBot, stopBot } from "./bot.js";
import { closeDb, getDb } from "./db/database.js";
import { startWebServer, stopWebServer } from "./server.js";
import { initRedis, closeRedis } from "./db/redis.js";
import { config } from "./config.js";
import { seedInitialCodes } from "./db/inviteRepo.js";
import { rotateSecretKey } from "./utils/crypto.js";
import { startPlaybookScheduleService, stopPlaybookScheduleService } from "./services/playbookScheduleService.js";
import { startReminderEngine, stopReminderEngine } from "./services/reminderEngine.js";
import { startClipboardCleanup, stopClipboardCleanup } from "./services/clipboardCleanupService.js";
import { startBirthdayReminderService, stopBirthdayReminderService } from "./services/birthdayReminderService.js";
import { startPaymentRecurrenceService, stopPaymentRecurrenceService } from "./services/paymentRecurrenceService.js";
import { startReportService, stopReportService } from "./services/reportService.js";
import { startBriefingService, stopBriefingService } from "./services/briefingService.js";
import { startBackupScheduler, stopBackupScheduler } from "./services/backupService.js";

async function main() {
  console.log("🚀 Yuuka 起動中...");

  // データベース初期化（スキーマv2）
  await runMigrations();

  // SECRET_KEY ローテーション（SECRET_KEY_NEW 設定時のみ実行 §6.2.1）
  if (config.secretKeyNew) {
    rotateSecretKey(getDb());
  }

  // 招待コードの初期投入（config.yamlから）
  if (config.inviteCodes.length > 0) {
    seedInitialCodes(config.inviteCodes);
    console.log(`🎫 招待コード ${config.inviteCodes.length} 件をDBに投入しました`);
  }

  // Redis の初期化と接続（会話コンテキスト・セッション管理）
  await initRedis();

  // Web管理画面サーバーの起動
  await startWebServer();

  // Bot起動
  await startBot();

  // cron系サービスの起動
  startReminderEngine();           // リマインド（§3.3）+ ToDo期限 + 予定リマインド
  startPlaybookScheduleService();  // マクロ/Playbook定期実行（§3.6）
  startClipboardCleanup();         // クリップボードTTL（§3.10）
  startBirthdayReminderService();  // 誕生日リマインド（§3.11）
  startPaymentRecurrenceService(); // 繰り返し支払い予定の自動生成（§3.4）
  startReportService();            // 日報・週報（§3.8）
  startBriefingService();          // 朝報: 天気・ニュース（§3.9）
  startBackupScheduler();          // ユーザー単位Google Driveバックアップ（§8）

  console.log("✨ Yuuka が起動しました！");
}

async function gracefulShutdown(): Promise<void> {
  stopBackupScheduler();
  stopBriefingService();
  stopReportService();
  stopPaymentRecurrenceService();
  stopBirthdayReminderService();
  stopClipboardCleanup();
  stopPlaybookScheduleService();
  stopReminderEngine();
  stopWebServer();
  stopBot();
  closeDb();
  await closeRedis();
}

process.on("SIGINT", async () => {
  console.log("\n👋 シャットダウン中...");
  await gracefulShutdown();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n👋 シャットダウン中...");
  await gracefulShutdown();
  process.exit(0);
});

main().catch(async (err) => {
  console.error("起動エラー:", err);
  stopWebServer();
  closeDb();
  await closeRedis();
  process.exit(1);
});
