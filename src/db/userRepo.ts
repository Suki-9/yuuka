import crypto from "node:crypto";
import { getDb } from "./database.js";

export interface UserRecord {
  discord_id: string;
  username: string;
  password_hash: string;
  gemini_api_key_encrypted: string | null;
  gemini_api_key_iv: string | null;
  gemini_api_key_tag: string | null;
  gemini_model: string;
  google_client_id: string | null;
  google_client_secret: string | null;
  google_refresh_token: string | null;
  google_calendar_id: string | null;
  google_calendars: string | null;
  google_drive_backup_enabled: number;
  google_drive_backup_folder_id: string | null;
  backup_cron: string;
  created_at: string;
  updated_at: string;
}

export interface GeminiConfig {
  apiKeyEncrypted: string | null;
  apiKeyIv: string | null;
  apiKeyTag: string | null;
  model: string;
}

export interface GoogleConfig {
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  calendarId: string | null;
  calendars: string[];
}

// --- パスワードハッシュ (scrypt: memory-hard, Node.js built-in) ---

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N
const SCRYPT_BLOCK_SIZE = 8; // r
const SCRYPT_PARALLELIZATION = 1; // p

/**
 * パスワードをscryptでハッシュ化する
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  }).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * パスワードとハッシュを照合する（タイミング攻撃耐性あり）
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  }).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(derived, "hex"));
}

// --- ユーザーCRUD ---

/**
 * ユーザーを新規登録する
 */
export function createUser(discordId: string, username: string, password: string): UserRecord {
  const db = getDb();
  const passwordHash = hashPassword(password);
  const stmt = db.prepare(`
    INSERT INTO users (discord_id, username, password_hash)
    VALUES (?, ?, ?)
  `);
  stmt.run(discordId, username, passwordHash);
  return getUserByDiscordId(discordId)!;
}

/**
 * Discord IDでユーザーを取得する
 */
export function getUserByDiscordId(discordId: string): UserRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId) as UserRecord | undefined;
}

/**
 * ユーザーが登録済みかどうか高速に判定する（Botのメッセージフィルタ用）
 */
export function isRegisteredUser(discordId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM users WHERE discord_id = ? LIMIT 1").get(discordId);
  return !!row;
}

/**
 * ユーザーネームを変更する
 */
export function updateUsername(discordId: string, newUsername: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE users SET username = ?, updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `).run(newUsername, discordId);
  return result.changes > 0;
}

/**
 * ユーザーのGemini設定を更新する
 */
export function updateGeminiSettings(
  discordId: string,
  apiKeyEncrypted: string | null,
  apiKeyIv: string | null,
  apiKeyTag: string | null,
  model: string
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE users SET
      gemini_api_key_encrypted = ?,
      gemini_api_key_iv = ?,
      gemini_api_key_tag = ?,
      gemini_model = ?,
      updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `).run(apiKeyEncrypted, apiKeyIv, apiKeyTag, model, discordId);
  return result.changes > 0;
}

/**
 * ユーザーのGoogle OAuth設定を更新する
 */
export function updateGoogleSettings(
  discordId: string,
  clientId: string | null,
  clientSecret: string | null,
  refreshToken: string | null,
  calendarId: string | null,
  calendars: string[]
): boolean {
  const db = getDb();
  const calendarsJson = calendars.length > 0 ? JSON.stringify(calendars) : null;
  const result = db.prepare(`
    UPDATE users SET
      google_client_id = ?,
      google_client_secret = ?,
      google_refresh_token = ?,
      google_calendar_id = ?,
      google_calendars = ?,
      updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `).run(clientId, clientSecret, refreshToken, calendarId, calendarsJson, discordId);
  return result.changes > 0;
}

/**
 * ユーザーのバックアップ設定を更新する
 */
export function updateBackupSettings(
  discordId: string,
  enabled: boolean,
  folderId: string | null,
  cron: string
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE users SET
      google_drive_backup_enabled = ?,
      google_drive_backup_folder_id = ?,
      backup_cron = ?,
      updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `).run(enabled ? 1 : 0, folderId, cron, discordId);
  return result.changes > 0;
}

/**
 * ユーザーのGemini設定のみ取得する
 */
export function getUserGeminiConfig(discordId: string): GeminiConfig | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT gemini_api_key_encrypted, gemini_api_key_iv, gemini_api_key_tag, gemini_model
    FROM users WHERE discord_id = ?
  `).get(discordId) as {
    gemini_api_key_encrypted: string | null;
    gemini_api_key_iv: string | null;
    gemini_api_key_tag: string | null;
    gemini_model: string;
  } | undefined;

  if (!row) return null;
  return {
    apiKeyEncrypted: row.gemini_api_key_encrypted,
    apiKeyIv: row.gemini_api_key_iv,
    apiKeyTag: row.gemini_api_key_tag,
    model: row.gemini_model,
  };
}

/**
 * ユーザーのGoogle OAuth設定のみ取得する
 */
export function getUserGoogleConfig(discordId: string): GoogleConfig | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT google_client_id, google_client_secret, google_refresh_token,
           google_calendar_id, google_calendars
    FROM users WHERE discord_id = ?
  `).get(discordId) as {
    google_client_id: string | null;
    google_client_secret: string | null;
    google_refresh_token: string | null;
    google_calendar_id: string | null;
    google_calendars: string | null;
  } | undefined;

  if (!row) return null;

  let calendars: string[] = [];
  if (row.google_calendars) {
    try {
      calendars = JSON.parse(row.google_calendars);
    } catch {
      calendars = [];
    }
  }

  return {
    clientId: row.google_client_id,
    clientSecret: row.google_client_secret,
    refreshToken: row.google_refresh_token,
    calendarId: row.google_calendar_id,
    calendars,
  };
}

/**
 * 登録済みユーザーID一覧を取得する
 */
export function listAllUserIds(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT discord_id FROM users ORDER BY created_at ASC").all() as { discord_id: string }[];
  return rows.map(r => r.discord_id);
}

/**
 * ユーザーを削除する
 */
export function deleteUser(discordId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM users WHERE discord_id = ?").run(discordId);
  return result.changes > 0;
}

/**
 * Google Refresh Tokenのみ更新する（OAuthコールバック用）
 */
export function updateGoogleRefreshToken(discordId: string, refreshToken: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE users SET google_refresh_token = ?, updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `).run(refreshToken, discordId);
  return result.changes > 0;
}
