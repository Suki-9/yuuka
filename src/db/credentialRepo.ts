import { getDb } from "./database.js";

export interface CredentialRecord {
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
  serviceName: string,
  username: string,
  encryptedPassword: string,
  iv: string,
  authTag: string
): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO credentials (service_name, username, encrypted_password, iv, auth_tag, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(service_name) DO UPDATE SET
      username = excluded.username,
      encrypted_password = excluded.encrypted_password,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      updated_at = datetime('now', 'localtime')
  `);
  stmt.run(serviceName, username, encryptedPassword, iv, authTag);
}

/**
 * 復号に必要な暗号化データを含めて資格情報を1件取得する
 */
export function getCredential(serviceName: string): CredentialRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM credentials WHERE service_name = ?")
    .get(serviceName) as CredentialRecord | undefined;
}

/**
 * 資格情報を完全削除する
 */
export function deleteCredential(serviceName: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM credentials WHERE service_name = ?").run(serviceName);
  return result.changes > 0;
}

/**
 * 安全に一覧表示するために、暗号化されていない「インデックス情報」のみを全件取得する
 */
export function listCredentials(): CredentialIndex[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT service_name, username, updated_at FROM credentials ORDER BY service_name ASC")
    .all() as { service_name: string; username: string; updated_at: string }[];

  return rows.map((row) => ({
    serviceName: row.service_name,
    username: row.username,
    updatedAt: row.updated_at,
  }));
}
