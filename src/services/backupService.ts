import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
// @ts-expect-error @types/archiver is outdated for v8
import { ZipArchive } from "archiver";
import Database from "better-sqlite3";
import { getDb } from "../db/database.js";
import {
  getUserBackupConfig,
  getUserByDiscordId,
  listAllUserIds,
  touchBackupLastRun,
} from "../db/userRepo.js";
import { uploadToGoogleDrive, listBackupFiles, deleteDriveFile } from "./googleDriveService.js";

// ─── ユーザー単位バックアップ（§8） ──────────────────────────────────────────
// SQLiteから当該ユーザーの行のみを抽出した一時DBをZIP化し、
// ユーザー個人のGoogle Driveへタイムスタンプ付きファイル名でアップロードする。
// 世代管理: backup_generations 世代を超える古いファイルをDriveから削除する。

const BACKUP_PREFIX = "yuuka_backup_";

/** user_id 列で分離されているユーザーデータテーブル（v2スキーマ） */
const USER_SCOPED_TABLES = [
  "personas",
  "bot_active_personas",  // v8: (user_id, bot_id) 単位の適用ペルソナ状態
  "message_logs",
  "todos",
  "schedules",
  "reminders",
  "expenses",
  "budget_limits",
  "planned_payments",
  "playbooks",
  "playbook_schedules",
  "playbook_runs",
  "clipboard_entries",
  "contacts",
  "credentials",
  "webhook_endpoints",
  "webhook_deliveries",
];

/** user_id が主キーの単一行テーブル */
const USER_KEYED_TABLES = ["context_notes", "briefing_configs"];

/**
 * データベーススキーマと当該ユーザーのデータのみを新しい一時SQLiteファイルにエクスポートする
 */
export function exportUserData(userId: string, tempDbPath: string): void {
  if (fs.existsSync(tempDbPath)) {
    fs.unlinkSync(tempDbPath);
  }

  const srcDb = getDb();
  const destDb = new Database(tempDbPath);

  try {
    // 1. 全テーブルおよびインデックスの定義（スキーマ）をコピー
    //    （FTS5仮想テーブル・内部シャドウテーブル・トリガーは除外し、通常テーブルのみ）
    const schemaRows = srcDb.prepare(`
      SELECT sql, name FROM sqlite_master
      WHERE type IN ('table', 'index') AND sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE 'message_logs_fts%'
    `).all() as { sql: string; name: string }[];

    destDb.transaction(() => {
      for (const row of schemaRows) {
        try {
          destDb.exec(row.sql);
        } catch (err) {
          console.warn(`バックアップ用スキーマコピーをスキップ (${row.name}):`, err);
        }
      }
    })();

    const copyRows = (table: string, whereColumn: string) => {
      let rows: Record<string, unknown>[];
      try {
        rows = srcDb
          .prepare(`SELECT * FROM ${table} WHERE ${whereColumn} = ?`)
          .all(userId) as Record<string, unknown>[];
      } catch {
        return; // テーブル不存在はスキップ
      }
      if (rows.length === 0) return;
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => "?").join(", ");
      const insertStmt = destDb.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
      );
      for (const row of rows) {
        insertStmt.run(...columns.map((c) => row[c]));
      }
    };

    // 2. ユーザー関連データのみをINSERT
    destDb.transaction(() => {
      // users: 本人の行のみ
      copyRows("users", "discord_id");
      // user_id スコープのテーブル群
      for (const table of [...USER_SCOPED_TABLES, ...USER_KEYED_TABLES]) {
        copyRows(table, "user_id");
      }
      // report_configs / mcp_servers（user_id列）
      copyRows("report_configs", "user_id");
      copyRows("mcp_servers", "user_id");
      // bots: 本人がオーナーのBot
      copyRows("bots", "user_id");
    })();
  } finally {
    destDb.close();
  }
}

/** タイムスタンプ付きバックアップファイル名（例: yuuka_backup_20260612_043000.zip） */
function backupFileName(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${BACKUP_PREFIX}${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`
  );
}

/**
 * ユーザーデータをZIP化してGoogle Driveへバックアップし、古い世代を削除する（§8.2）
 * @returns アップロードしたファイルのURL
 */
export async function runBackup(userId: string): Promise<string> {
  const backupConfig = getUserBackupConfig(userId);
  const user = getUserByDiscordId(userId);
  if (!user) {
    throw new Error("ユーザーが存在しません。");
  }
  if (!backupConfig || !backupConfig.enabled) {
    throw new Error("バックアップ設定が無効になっています。");
  }

  const tmpDir = path.resolve(process.cwd(), "scratch");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tempDbPath = path.join(tmpDir, `yuuka_${userId}_${timestamp}.db`);
  const zipPath = path.join(tmpDir, `backup_${userId}_${timestamp}.zip`);

  try {
    // 1. ユーザー固有のデータのみをエクスポート
    exportUserData(userId, tempDbPath);

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

      archive.finalize();
    });

    // 3. Google Driveへアップロード（タイムスタンプ付き新規ファイル）
    const fileName = backupFileName();
    const result = await uploadToGoogleDrive(
      userId,
      zipPath,
      fileName,
      "application/zip",
      backupConfig.folderId || undefined
    );

    // 4. 世代管理: 保持世代数を超える古いバックアップを削除（§8.2）
    try {
      const generations = Math.max(1, backupConfig.generations || 7);
      const files = await listBackupFiles(userId, BACKUP_PREFIX, backupConfig.folderId || undefined);
      // createdTime desc で取得済み。generations 件目以降を削除する
      const stale = files.slice(generations);
      for (const file of stale) {
        const ok = await deleteDriveFile(userId, file.id);
        if (ok) {
          console.log(`🗑️ [Backup] 古い世代を削除しました: ${file.name}`);
        }
      }
    } catch (pruneErr) {
      console.warn(`[Backup] 古い世代の削除に失敗しました (user: ${userId}):`, pruneErr);
    }

    touchBackupLastRun(userId);
    console.log(`✅ [Backup] ユーザー ${userId} のバックアップ完了: ${result?.url}`);
    return result?.url || "";
  } catch (err) {
    console.error(`❌ [Backup] ユーザー ${userId} のバックアップ処理中にエラーが発生しました:`, err);
    throw err;
  } finally {
    // 5. 一時ファイルのクリーンアップ
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
}

// ─── 定期バックアップスケジューラ ────────────────────────────────────────────
// バックアップ間隔はユーザーが時間単位で指定する（最短1時間〜最長720時間=30日 §8.2）。
// 毎時15分に全ユーザーを走査し、間隔を経過したユーザーのバックアップを実行する。

let schedulerTask: cron.ScheduledTask | null = null;

async function backupTick(): Promise<void> {
  // cron用・全ユーザー横断走査（例外クエリ）
  let userIds: string[];
  try {
    userIds = listAllUserIds();
  } catch (err) {
    console.error("[Backup] ユーザー一覧の取得に失敗しました:", err);
    return;
  }

  for (const userId of userIds) {
    try {
      const conf = getUserBackupConfig(userId);
      if (!conf || !conf.enabled) continue;

      const intervalMs = Math.max(1, conf.intervalHours || 24) * 60 * 60 * 1000;
      const lastRun = conf.lastRunAt ? new Date(conf.lastRunAt.replace(" ", "T")).getTime() : 0;
      if (Date.now() - lastRun < intervalMs) continue;

      console.log(`⏰ [Backup] ユーザー ${userId} の定期バックアップを開始します...`);
      await runBackup(userId);
    } catch (err) {
      console.error(`❌ [Backup] ユーザー ${userId} の定期バックアップに失敗しました:`, err);
    }
  }
}

export function startBackupScheduler(): void {
  if (schedulerTask) return;
  schedulerTask = cron.schedule("15 * * * *", () => {
    void backupTick();
  });
  console.log("💾 バックアップスケジューラを開始しました（毎時15分に間隔判定）");
}

export function stopBackupScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
  }
}
