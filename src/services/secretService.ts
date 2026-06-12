import * as credentialRepo from "../db/credentialRepo.js";
import type { CredentialIndexEntry } from "../db/credentialRepo.js";
import { encryptForUser, decryptForUser } from "../utils/crypto.js";
import { getUserSalt } from "../db/userRepo.js";
import { addAuditLog } from "../db/auditRepo.js";

// ─── パスワードマネージャ サービス層（§6） ───────────────────────────────────
//
// 暗号化方式（§6.2.1）: SECRET_KEY + ユーザー固有ソルト（users.salt）を Argon2id に通して
// 導出したユーザー鍵で AES-256-GCM 暗号化する（crypto.ts の encryptForUser / decryptForUser）。
// 全アクセス（読取・書込・削除）は監査ログに記録する（§6.3.3）。
// 監査ログ・コンソールログ・例外メッセージにパスワード本体を含めることは絶対に禁止。

/** 復号済み認証情報（呼び出し元はブラウザ入力等の最小限の用途に限ること。§6.3.2） */
export interface DecryptedCredential {
  username: string;
  password: string;
  url?: string;
}

/** updateCredential で部分更新可能なフィールド */
export interface CredentialUpdateFields {
  username?: string;
  password?: string;
  url?: string;
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** サービス名の正規化（trim + 小文字化）。全公開関数の入口で必ず通す */
function normalizeServiceName(serviceName: string): string {
  return serviceName.trim().toLowerCase();
}

/** ユーザー鍵導出用ソルトの取得（未登録ユーザーは認証情報を保持できない） */
function requireUserSalt(userId: string): string {
  const salt = getUserSalt(userId);
  if (!salt) {
    throw new Error("ユーザーが登録されていないため、パスワードマネージャを利用できません。先にユーザー登録を完了してください。");
  }
  return salt;
}

// ─── 公開API ─────────────────────────────────────────────────────────────────

/**
 * 認証情報を新規登録する（同名サービスが既にある場合は上書き）
 * 監査: credential.write（パスワード本体は記録しない）
 */
export function registerCredential(
  userId: string,
  serviceName: string,
  username: string,
  password: string,
  url?: string
): void {
  const cleanServiceName = normalizeServiceName(serviceName);
  if (!cleanServiceName) {
    throw new Error("サービス名が空です。");
  }
  const cleanUsername = username.trim();
  if (!cleanUsername || !password) {
    throw new Error("ユーザー名とパスワードは必須です。");
  }
  const cleanUrl = url?.trim() || null;

  const salt = requireUserSalt(userId);
  const existing = credentialRepo.getCredentialRecord(userId, cleanServiceName);

  // パスワードをユーザー鍵（Argon2id導出 + AES-256-GCM）で暗号化（§6.2.1）
  const { encrypted, iv, authTag } = encryptForUser(userId, salt, password);
  credentialRepo.saveCredential(userId, cleanServiceName, cleanUsername, encrypted, iv, authTag, cleanUrl);

  addAuditLog(userId, "credential.write", cleanServiceName, existing ? "上書き登録" : "新規登録");
  console.log(`🔐 [PWマネージャ] 認証情報を${existing ? "上書き" : ""}登録しました: ${cleanServiceName} (User: ${userId})`);
}

/**
 * 既存の認証情報を部分更新する（username / password / url のうち指定されたもののみ変更）。
 * url に空文字を指定した場合は URL を削除する。
 * @returns 対象サービスが存在しない場合は false
 * 監査: credential.write（変更フィールド名のみ記録。値は記録しない）
 */
export function updateCredential(
  userId: string,
  serviceName: string,
  fields: CredentialUpdateFields
): boolean {
  const cleanServiceName = normalizeServiceName(serviceName);
  const record = credentialRepo.getCredentialRecord(userId, cleanServiceName);
  if (!record) return false;

  const changedFields: string[] = [];

  // ユーザー名: 指定があれば差し替え
  let username = record.username;
  if (fields.username !== undefined && fields.username.trim()) {
    username = fields.username.trim();
    changedFields.push("username");
  }

  // URL: 指定があれば差し替え（空文字は削除扱い）
  let url: string | null = record.url;
  if (fields.url !== undefined) {
    url = fields.url.trim() || null;
    changedFields.push("url");
  }

  // パスワード: 指定があれば新しいIVで再暗号化、無ければ既存の暗号文を維持（§6.2.1）
  let encrypted = record.encrypted_password;
  let iv = record.iv;
  let authTag = record.auth_tag;
  if (fields.password !== undefined && fields.password.length > 0) {
    const salt = requireUserSalt(userId);
    const enc = encryptForUser(userId, salt, fields.password);
    encrypted = enc.encrypted;
    iv = enc.iv;
    authTag = enc.authTag;
    changedFields.push("password");
  }

  if (changedFields.length === 0) {
    throw new Error("更新する項目（username / password / url）を1つ以上指定してください。");
  }

  credentialRepo.saveCredential(userId, cleanServiceName, username, encrypted, iv, authTag, url);

  addAuditLog(userId, "credential.write", cleanServiceName, `更新 (${changedFields.join(", ")})`);
  console.log(`🔐 [PWマネージャ] 認証情報を更新しました: ${cleanServiceName} [${changedFields.join(", ")}] (User: ${userId})`);
  return true;
}

/**
 * 認証情報をオンデマンドで復号して取得する。
 * 復号値の用途はブラウザ入力等の最小限に限り、LLMの応答・プロンプト・ログに含めてはならない（§6.3.2）。
 * 監査: credential.read（target はサービス名のみ。パスワード本体は絶対に記録しない）
 */
export function getDecryptedCredential(userId: string, serviceName: string): DecryptedCredential | null {
  const cleanServiceName = normalizeServiceName(serviceName);
  const record = credentialRepo.getCredentialRecord(userId, cleanServiceName);
  if (!record) return null;

  const salt = requireUserSalt(userId);
  let password: string;
  try {
    password = decryptForUser(userId, salt, record.encrypted_password, record.iv, record.auth_tag);
  } catch (err) {
    // 復号失敗（SECRET_KEY変更等）。エラー詳細に秘密値は含まれない
    console.error(`❌ [PWマネージャ] 認証情報 [${cleanServiceName}] の復号に失敗しました:`, (err as Error).message);
    throw new Error(`認証情報 [${cleanServiceName}] の復号に失敗しました。SECRET_KEY が変更された可能性があります。`);
  }

  addAuditLog(userId, "credential.read", cleanServiceName);
  console.log(`🔓 [PWマネージャ] 認証情報を復号しました: ${cleanServiceName} (User: ${userId})`);

  return {
    username: record.username,
    password,
    ...(record.url ? { url: record.url } : {}),
  };
}

/**
 * 認証情報を完全削除する
 * 監査: credential.delete
 */
export function deleteCredential(userId: string, serviceName: string): boolean {
  const cleanServiceName = normalizeServiceName(serviceName);
  const deleted = credentialRepo.deleteCredential(userId, cleanServiceName);
  if (deleted) {
    addAuditLog(userId, "credential.delete", cleanServiceName);
    console.log(`🗑️ [PWマネージャ] 認証情報を削除しました: ${cleanServiceName} (User: ${userId})`);
  }
  return deleted;
}

/**
 * 登録済みサービスの一覧を取得する（パスワード関連列は一切含まない。§6.4 list_services）
 */
export function listCredentialServices(userId: string): CredentialIndexEntry[] {
  return credentialRepo.listCredentials(userId);
}
