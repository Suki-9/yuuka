import crypto from "node:crypto";
import { getDb } from "./database.js";

export interface UserRecord {
  discord_id: string;
  username: string;
  password_hash: string;
  role: string;
  created_at: string;
  updated_at: string;
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
export function createUser(
  discordId: string,
  username: string,
  password: string,
  geminiApiKeyEncrypted: string,
  geminiApiKeyIv: string,
  geminiApiKeyTag: string,
  geminiModel: string = "gemini-3.1-flash-lite"
): UserRecord {
  const db = getDb();
  const passwordHash = hashPassword(password);
  
  const runTx = db.transaction(() => {
    const countRow = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    const isFirstUser = countRow.count === 0;
    const role = isFirstUser ? "admin" : "user";

    db.prepare(`
      INSERT INTO users (
        discord_id, username, password_hash, role,
        gemini_api_key_encrypted, gemini_api_key_iv, gemini_api_key_tag, gemini_model
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      discordId, username, passwordHash, role,
      geminiApiKeyEncrypted, geminiApiKeyIv, geminiApiKeyTag, geminiModel
    );
  });
  
  runTx();
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

// --- Admin RBAC ---

/**
 * Admin用ユーザー情報（パスワードハッシュを除外）
 */
export interface AdminUserView {
  discord_id: string;
  username: string;
  role: string;
  created_at: string;
  updated_at: string;
}

/**
 * 全ユーザー一覧を取得する（Admin用、パスワードハッシュ除外）
 */
export function listAllUsers(): AdminUserView[] {
  const db = getDb();
  return db.prepare(
    "SELECT discord_id, username, role, created_at, updated_at FROM users ORDER BY created_at ASC"
  ).all() as AdminUserView[];
}

/**
 * ユーザーのロールを変更する
 */
export function updateUserRole(discordId: string, role: string): boolean {
  if (role !== "user" && role !== "admin") return false;
  const db = getDb();
  const result = db.prepare(
    "UPDATE users SET role = ?, updated_at = datetime('now', 'localtime') WHERE discord_id = ?"
  ).run(role, discordId);
  return result.changes > 0;
}

/**
 * ユーザーが Admin かどうか判定する
 */
export function isAdmin(discordId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM users WHERE discord_id = ? AND role = 'admin' LIMIT 1"
  ).get(discordId);
  return !!row;
}

export interface UserGeminiConfig {
  apiKeyEncrypted: string | null;
  apiKeyIv: string | null;
  apiKeyTag: string | null;
  model: string;
}

/**
 * ユーザーのGemini設定を取得する
 */
export function getUserGeminiConfig(discordId: string): UserGeminiConfig | null {
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
    model: row.gemini_model || "gemini-3.1-flash-lite",
  };
}

/**
 * ユーザーのGemini設定を更新する
 */
export function updateUserGeminiSettings(
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
