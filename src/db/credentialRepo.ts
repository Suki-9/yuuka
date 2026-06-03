import { getDb } from "./database.js";

export interface CredentialRecord {
  bot_id: string;
  service_name: string;
  username: string;
  encrypted_password: string;
  iv: string;
  auth_tag: string;
  updated_at: string;
}

export interface CredentialIndex {
  serviceName: string;
  username: string;
  updatedAt: string;
}

/**
 * 資格情報を暗号化されたデータと共にデータベースに保存する（INSERT または REPLACE）
 */
export function saveCredential(
  botId: string,
  serviceName: string,
  username: string,
  encryptedPassword: string,
  iv: string,
  authTag: string
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO credentials (bot_id, service_name, username, encrypted_password, iv, auth_tag, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(bot_id, service_name) DO UPDATE SET
      username = excluded.username,
      encrypted_password = excluded.encrypted_password,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      updated_at = datetime('now', 'localtime')
  `);
  stmt.run(botId, serviceName, username, encryptedPassword, iv, authTag);
}

/**
 * 復号に必要な暗号化データを含めて資格情報を1件取得する
 */
export function getCredential(botId: string, serviceName: string): CredentialRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM credentials WHERE bot_id = ? AND service_name = ?")
    .get(botId, serviceName) as CredentialRecord | undefined;
}

/**
 * 資格情報を完全削除する
 */
export function deleteCredential(botId: string, serviceName: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM credentials WHERE bot_id = ? AND service_name = ?").run(botId, serviceName);
  return result.changes > 0;
}

/**
 * 安全に一覧表示するために、暗号化されていない「インデックス情報」のみを取得する
 */
export function listCredentials(botId: string): CredentialIndex[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT service_name, username, updated_at FROM credentials WHERE bot_id = ? ORDER BY service_name ASC")
    .all(botId) as { service_name: string; username: string; updated_at: string }[];

  return rows.map((row) => ({
    serviceName: row.service_name,
    username: row.username,
    updatedAt: row.updated_at,
  }));
}
