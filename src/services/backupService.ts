import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
// @ts-expect-error @types/archiver is outdated for v8
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import { getDb } from "../db/database.js";
import { getBotById } from "../db/botRepo.js";
import { uploadToGoogleDrive } from "./googleDriveService.js";

const BACKUP_ZIP_NAME = "yuuka_backup.zip";
// Botごとの定期タスク管理
const activeCronTasks = new Map<string, cron.ScheduledTask>();

/**
 * データベーススキーマと特定Botのデータのみを新しい一時SQLiteファイルにエクスポートする
 */
function exportSingleBotDb(botId: string, tempDbPath: string): void {
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }

  const srcDb = getDb();
  const destDb = new Database(tempDbPath);

  try {
    // 1. 全テーブルおよびインデックスの定義（スキーマ）をコピー
    const schemaRows = srcDb.prepare(`
      SELECT sql FROM sqlite_master 
      WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    `).all() as { sql: string }[];

    destDb.transaction(() => {
      for (const row of schemaRows) {
        destDb.exec(row.sql);
      }
    })();

    // 2. Bot関連データのみをINSERT
    destDb.transaction(() => {
      // bots: 本ボットのみ
      const botRows = srcDb.prepare("SELECT * FROM bots WHERE id = ?").all(botId);
      if (botRows.length > 0) {
        const columns = Object.keys(botRows[0] as object);
        const placeholders = columns.map(() => "?").join(", ");
        const insertBot = destDb.prepare(`INSERT INTO bots (${columns.join(", ")}) VALUES (${placeholders})`);
        for (const row of botRows) {
          insertBot.run(Object.values(row as object));
        }
      }

      // bot_id による完全分離テーブル
      const botSpecificTables = ["tasks", "schedules", "expenses", "chat_history", "credentials", "playbooks"];
      for (const table of botSpecificTables) {
        const rows = srcDb.prepare(`SELECT * FROM ${table} WHERE bot_id = ?`).all(botId);
        if (rows.length > 0) {
          const columns = Object.keys(rows[0] as object);
          const placeholders = columns.map(() => "?").join(", ");
          const insertStmt = destDb.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
          for (const row of rows) {
            insertStmt.run(Object.values(row as object));
          }
        }
      }
    })();
  } finally {
    destDb.close();
  }
}

/**
 * データベースや各種設定ファイルをZIP化して、指定BotのGoogle Driveにバックアップする
 */
export async function runBackup(botId: string): Promise<string> {
  const bot = getBotById(botId);
  if (!bot || !bot.google_drive_backup_enabled) {
    throw new Error("バックアップ設定が無効になっているか、Botが存在しません。");
  }

  const tmpDir = path.resolve(process.cwd(), "scratch");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDbPath = path.join(tmpDir, `yuuka_${timestamp}.db`);
  const zipPath = path.join(tmpDir, `backup_${timestamp}.zip`);

  try {
    // 1. 安全にBot固有のデータのみをエクスポート
    exportSingleBotDb(botId, tempDbPath);

    // 2. ZIPファイルの作成
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = new ZipArchive({
        zlib: { level: 9 },
      });

      output.on("close", () => resolve());
      archive.on("warning", (err: any) => {
        if (err.code === "ENOENT") {
          console.warn("ZIP作成中に警告:", err);
        } else {
          reject(err);
        }
      });
      archive.on("error", (err: any) => reject(err));

      archive.pipe(output);

      // 一時保存したDBファイルを 'yuuka.db' としてZIPに追加
      archive.file(tempDbPath, { name: "data/yuuka.db" });

      // config.yaml が存在すれば追加
      const configPath = path.resolve(process.cwd(), "config.yaml");
      if (fs.existsSync(configPath)) {
        archive.file(configPath, { name: "config.yaml" });
      }

      // data/self-expansion を追加
      const selfExpansionDir = path.resolve(process.cwd(), "data", "self-expansion");
      if (fs.existsSync(selfExpansionDir)) {
        archive.directory(selfExpansionDir, "data/self-expansion");
      }

      archive.finalize();
    });

    // 3. Google Driveへアップロード（上書き）
    const result = await uploadToGoogleDrive(
      botId,
      zipPath,
      BACKUP_ZIP_NAME,
      "application/zip",
      bot.google_drive_backup_folder_id || undefined
    );

    console.log(`✅ [Bot: ${botId}] バックアップ完了: ${result?.url}`);
    return result?.url || "";

  } catch (err) {
    console.error(`❌ [Bot: ${botId}] バックアップ処理中にエラーが発生しました:`, err);
    throw err;
  } finally {
    // 4. 一時ファイルのクリーンアップ
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
}

/**
 * 特定Botのバックアップスケジュールを再初期化する
 */
export function initBotBackupSchedule(botId: string): void {
  // 既存のタスクがあれば停止して削除
  const existingTask = activeCronTasks.get(botId);
  if (existingTask) {
    existingTask.stop();
    activeCronTasks.delete(botId);
  }

  const bot = getBotById(botId);
  if (!bot) return;

  if (bot.google_drive_backup_enabled) {
    const cronTime = bot.backup_cron || "0 3 * * *"; // デフォルト: 毎日深夜3時
    try {
      const task = cron.schedule(cronTime, async () => {
        console.log(`⏰ [Bot: ${botId}] 定期バックアップ処理を開始します...`);
        try {
          await runBackup(botId);
        } catch (err) {
          console.error(`❌ [Bot: ${botId}] 定期バックアップに失敗しました:`, err);
        }
      });
      activeCronTasks.set(botId, task);
      console.log(`🕒 [Bot: ${botId}] バックアップスケジュールを登録しました (cron: ${cronTime})`);
    } catch (err) {
      console.error(`❌ [Bot: ${botId}] バックアップ用のCron式が無効です:`, err);
    }
  } else {
    console.log(`⏸️ [Bot: ${botId}] 定期バックアップは無効化されています。`);
  }
}

/**
 * 全Botのバックアップスケジュールを初期化する
 */
export function initAllBackupSchedules(botIds: string[]): void {
  // 既存のスケジュールをすべてクリア
  for (const [botId, task] of activeCronTasks.entries()) {
    task.stop();
  }
  activeCronTasks.clear();

  for (const botId of botIds) {
    initBotBackupSchedule(botId);
  }
}
