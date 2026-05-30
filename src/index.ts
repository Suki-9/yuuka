import { runMigrations } from "./db/migrations.js";
import { startBot, stopBot } from "./bot.js";
import { closeDb } from "./db/database.js";
import { startWebServer, stopWebServer } from "./server.js";
import { initRedis, closeRedis } from "./db/redis.js";
import { config } from "./config.js";
import { seedInitialCodes } from "./db/inviteRepo.js";

async function main() {
  console.log("🚀 Yuuka 起動中...");

  // データベース初期化
  runMigrations();

  // 招待コードの初期投入（config.yamlから）
  if (config.inviteCodes.length > 0) {
    seedInitialCodes(config.inviteCodes);
    console.log(`🎫 招待コード ${config.inviteCodes.length} 件をDBに投入しました`);
  }

  // Redis の初期化と接続
  await initRedis();

  // Web管理画面サーバーの起動
  await startWebServer();

  // Bot起動
  await startBot();

  console.log("✨ Yuuka が起動しました！");
}

// グレースフルシャットダウン
process.on("SIGINT", async () => {
  console.log("\n👋 シャットダウン中...");
  stopWebServer();
  stopBot();
  closeDb();
  await closeRedis();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n👋 シャットダウン中...");
  stopWebServer();
  stopBot();
  closeDb();
  await closeRedis();
  process.exit(0);
});

main().catch(async (err) => {
  console.error("起動エラー:", err);
  stopWebServer();
  closeDb();
  await closeRedis();
  process.exit(1);
});
