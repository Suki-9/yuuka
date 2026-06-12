import { getDb } from "./database.js";

// ─── パスワードマネージャ リポジトリ（§6） ───────────────────────────────────
//
// credentials テーブル（v2: user_id + service_name 複合PK、url 列あり。定義は migrations.ts）。
// データ分離の原則: 全クエリは user_id（DiscordユーザーID）を WHERE 必須条件とする（§6.3.1）。
// パスワードはユーザー鍵（Argon2id + AES-256-GCM）で暗号化された状態でのみ保存・取得する。
// 暗号化・復号・監査ログは services/secretService.ts が担当し、本ファイルは永続化のみを担う。

/** credentials テーブルの1行（パスワードは暗号化済みの状態） */
export interface CredentialRecord {
  user_id: string;
  service_name: string;
  url: string | null;
  username: string;
  encrypted_password: string;
  iv: string;
  auth_tag: string;
  updated_at: string;
}

/** 一覧表示用のインデックス情報（パスワード関連列は一切含まない） */
export interface CredentialIndexEntry {
  service_name: string;
  username: string;
  url: string | null;
  updated_at: string;
}

/**
 * 認証情報を暗号化済みデータと共に保存する（同一 user_id + service_name は上書き）
 */
export function saveCredential(
  userId: string,
  serviceName: string,
  username: string,
  encryptedPassword: string,
  iv: string,
  authTag: string,
  url?: string | null
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO credentials (user_id, service_name, url, username, encrypted_password, iv, auth_tag, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(user_id, service_name) DO UPDATE SET
       url = excluded.url,
       username = excluded.username,
       encrypted_password = excluded.encrypted_password,
       iv = excluded.iv,
       auth_tag = excluded.auth_tag,
       updated_at = datetime('now', 'localtime')`
  ).run(userId, serviceName, url ?? null, username, encryptedPassword, iv, authTag);
}

/**
 * 復号に必要な暗号化データを含めて認証情報を1件取得する（呼び出し元は secretService のみとすること）
 */
export function getCredentialRecord(userId: string, serviceName: string): CredentialRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM credentials WHERE user_id = ? AND service_name = ?")
    .get(userId, serviceName) as CredentialRecord | undefined;
}

/**
 * 認証情報を完全削除する
 */
export function deleteCredential(userId: string, serviceName: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM credentials WHERE user_id = ? AND service_name = ?")
    .run(userId, serviceName);
  return result.changes > 0;
}

/**
 * 登録済み認証情報の一覧を取得する。
 * 安全のためパスワード関連列（encrypted_password / iv / auth_tag）は決して SELECT しない（§6.4 list_services）。
 */
export function listCredentials(userId: string): CredentialIndexEntry[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT service_name, username, url, updated_at FROM credentials WHERE user_id = ? ORDER BY service_name ASC"
    )
    .all(userId) as CredentialIndexEntry[];
}
