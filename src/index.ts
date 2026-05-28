import { runMigrations } from "./db/migrations.js";
import { startBot, stopBot } from "./bot.js";
import { closeDb } from "./db/database.js";
import { startWebServer, stopWebServer } from "./server.js";

async function main() {
  console.log("🚀 Yuuka 起動中...");

  // データベース初期化
  runMigrations();

  // Web管理画面サーバーの起動
  await startWebServer();

  // Bot起動
  await startBot();

  console.log("✨ Yuuka が起動しました！");
}

// グレースフルシャットダウン
process.on("SIGINT", () => {
  console.log("\n👋 シャットダウン中...");
  stopWebServer();
  stopBot();
  closeDb();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n👋 シャットダウン中...");
  stopWebServer();
  stopBot();
  closeDb();
  process.exit(0);
});

main().catch((err) => {
  console.error("起動エラー:", err);
  stopWebServer();
  closeDb();
  process.exit(1);
});
