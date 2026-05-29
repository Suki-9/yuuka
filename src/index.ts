import { runMigrations } from "./db/migrations.js";
import { startBot, stopBot } from "./bot.js";
import { closeDb } from "./db/database.js";
import { startWebServer, stopWebServer } from "./server.js";
import { initRedis, closeRedis } from "./db/redis.js";
import { initializeDynamicFunctions } from "./functions/index.js";

async function main() {
  console.log("🚀 Yuuka 起動中...");

  // 動的関数の初期化とロード
  await initializeDynamicFunctions();

  // データベース初期化
  runMigrations();

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
