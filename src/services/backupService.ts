import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
// @ts-expect-error @types/archiver is outdated for v8
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import { getDb } from "../db/database.js";
import { getUserByDiscordId } from "../db/userRepo.js";
import { uploadToGoogleDrive } from "./googleDriveService.js";

const BACKUP_ZIP_NAME = "yuuka_backup.zip";
// ユーザーごとの定期タスク管理
const activeCronTasks = new Map<string, cron.ScheduledTask>();

/**
 * データベーススキーマと特定ユーザーのデータのみを新しい一時SQLiteファイルにエクスポートする
 */
function exportSingleUserDb(userId: string, tempDbPath: string): void {
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

    // 2. ユーザー関連データのみをINSERT
    destDb.transaction(() => {
      // users: 本人のみ
      const userRows = srcDb.prepare("SELECT * FROM users WHERE discord_id = ?").all(userId);
      if (userRows.length > 0) {
        const columns = Object.keys(userRows[0] as object);
        const placeholders = columns.map(() => "?").join(", ");
        const insertUser = destDb.prepare(`INSERT INTO users (${columns.join(", ")}) VALUES (${placeholders})`);
        for (const row of userRows) {
          insertUser.run(Object.values(row as object));
        }
      }

      // invite_codes: 本人が作成した、または本人が使用した招待コードのみ
      const inviteRows = srcDb.prepare("SELECT * FROM invite_codes WHERE created_by = ? OR used_by = ?").all(userId, userId);
      if (inviteRows.length > 0) {
        const columns = Object.keys(inviteRows[0] as object);
        const placeholders = columns.map(() => "?").join(", ");
        const insertInvite = destDb.prepare(`INSERT INTO invite_codes (${columns.join(", ")}) VALUES (${placeholders})`);
        for (const row of inviteRows) {
          insertInvite.run(Object.values(row as object));
        }
      }

      // user_id による完全分離テーブル
      const userSpecificTables = ["tasks", "schedules", "expenses", "chat_history", "credentials", "playbooks"];
      for (const table of userSpecificTables) {
        const rows = srcDb.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(userId);
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
 * データベースや各種設定ファイルをZIP化して、指定ユーザーのGoogle Driveにバックアップする
 */
export async function runBackup(userId: string): Promise<string> {
  const user = getUserByDiscordId(userId);
  if (!user || !user.google_drive_backup_enabled) {
    throw new Error("バックアップ設定が無効になっているか、ユーザーが存在しません。");
  }

  const tmpDir = path.resolve(process.cwd(), "scratch");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDbPath = path.join(tmpDir, `yuuka_${timestamp}.db`);
  const zipPath = path.join(tmpDir, `backup_${timestamp}.zip`);

  try {
    // 1. 安全にユーザー固有のデータのみをエクスポート
    exportSingleUserDb(userId, tempDbPath);

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
      userId,
      zipPath,
      BACKUP_ZIP_NAME,
      "application/zip",
      user.google_drive_backup_folder_id || undefined
    );

    console.log(`✅ [User: ${userId}] バックアップ完了: ${result?.url}`);
    return result?.url || "";

  } catch (err) {
    console.error(`❌ [User: ${userId}] バックアップ処理中にエラーが発生しました:`, err);
    throw err;
  } finally {
    // 4. 一時ファイルのクリーンアップ
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
}

/**
 * 特定ユーザーのバックアップスケジュールを再初期化する
 */
export function initUserBackupSchedule(userId: string): void {
  // 既存のタスクがあれば停止して削除
  const existingTask = activeCronTasks.get(userId);
  if (existingTask) {
    existingTask.stop();
    activeCronTasks.delete(userId);
  }

  const user = getUserByDiscordId(userId);
  if (!user) return;

  if (user.google_drive_backup_enabled) {
    const cronTime = user.backup_cron || "0 3 * * *"; // デフォルト: 毎日深夜3時
    try {
      const task = cron.schedule(cronTime, async () => {
        console.log(`⏰ [User: ${userId}] 定期バックアップ処理を開始します...`);
        try {
          await runBackup(userId);
        } catch (err) {
          console.error(`❌ [User: ${userId}] 定期バックアップに失敗しました:`, err);
        }
      });
      activeCronTasks.set(userId, task);
      console.log(`🕒 [User: ${userId}] バックアップスケジュールを登録しました (cron: ${cronTime})`);
    } catch (err) {
      console.error(`❌ [User: ${userId}] バックアップ用のCron式が無効です:`, err);
    }
  } else {
    console.log(`⏸️ [User: ${userId}] 定期バックアップは無効化されています。`);
  }
}

/**
 * 全登録ユーザーのバックアップスケジュールを初期化する
 */
export function initAllBackupSchedules(userIds: string[]): void {
  // 既存のスケジュールをすべてクリア
  for (const [userId, task] of activeCronTasks.entries()) {
    task.stop();
  }
  activeCronTasks.clear();

  for (const userId of userIds) {
    initUserBackupSchedule(userId);
  }
}
