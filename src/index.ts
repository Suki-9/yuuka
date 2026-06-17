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

  // 保存時暗号化シークレットの必須チェック（§6.2）
  // YUUKA_ENCRYPTION_SECRET_NEW のみが設定されている場合は旧鍵からのローテーションとして起動を許可する
  if (!config.secretKey && !config.secretKeyNew) {
    console.error(
      "❌ 環境変数 YUUKA_ENCRYPTION_SECRET が設定されていません。十分に長いランダム文字列を設定してください。\n" +
      "   設定方法: .env ファイル（.env.example 参照）または systemd の Environment 等\n" +
      "   生成例: openssl rand -base64 48\n" +
      "   ※ プレリリース版をシークレット未設定で運用していた場合は、YUUKA_ENCRYPTION_SECRET_NEW に\n" +
      "     新しい鍵を設定して起動すると既存データが再暗号化されます（手順は .env.example / 仕様書 §6.2.1 参照）。"
    );
    process.exit(1);
  }

  // 暗号化シークレットの強度チェック（§6.2）: 弱い鍵は KDF の強度にかかわらず総当たりの前提条件になる。
  // 最低32文字（openssl rand -base64 48 等で十分に満たす）を要求する。
  const MIN_SECRET_LEN = 32;
  for (const [name, val] of [
    ["YUUKA_ENCRYPTION_SECRET", config.secretKey],
    ["YUUKA_ENCRYPTION_SECRET_NEW", config.secretKeyNew],
  ] as const) {
    if (val && val.length < MIN_SECRET_LEN) {
      console.error(
        `❌ ${name} が短すぎます（${val.length}文字）。推測困難な ${MIN_SECRET_LEN} 文字以上のランダム値を設定してください。\n` +
        "   生成例: openssl rand -base64 48"
      );
      process.exit(1);
    }
  }

  // データベース初期化（スキーマv2）
  await runMigrations();

  // 暗号化シークレットのローテーション（YUUKA_ENCRYPTION_SECRET_NEW 設定時のみ実行 §6.2.1）
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

let shuttingDown = false;

async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) return; // SIGINT/SIGTERM の二重受信や多重経路からの呼び出しを無視
  shuttingDown = true;

  // 停止処理自体がハングしても systemd の SIGKILL を待たず確実にプロセスを終える
  const watchdog = setTimeout(() => {
    console.error("⚠️ シャットダウンが15秒以内に完了しなかったため強制終了します。");
    process.exit(1);
  }, 15_000);
  watchdog.unref();

  try {
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
  } catch (err) {
    console.error("シャットダウン処理中にエラーが発生しました:", err);
  }
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

// ─── 最終防衛線（24/365 運用: 捕捉漏れでプロセスを落とさない / 落ちる時は確実に再起動させる） ───

// 捕捉漏れの Promise 拒否はログに残して稼働を継続する。
// （discord.js や cron コールバック等の深部で漏れた1件の拒否でBot全体を道連れにしない）
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ 未捕捉の Promise 拒否を検出しました（処理は継続します）:", reason);
});

// 同期例外はプロセス状態が壊れている可能性があるため、後始末をして終了し
// systemd (Restart=always) に再起動させる。
process.on("uncaughtException", async (err) => {
  console.error("💥 未捕捉の例外が発生しました。シャットダウンして再起動します:", err);
  try {
    await gracefulShutdown();
  } finally {
    process.exit(1);
  }
});

main().catch(async (err) => {
  console.error("起動エラー:", err);
  stopWebServer();
  closeDb();
  await closeRedis();
  process.exit(1);
});
