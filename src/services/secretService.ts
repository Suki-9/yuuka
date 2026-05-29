import * as credentialRepo from "../db/credentialRepo.js";
import { encryptText, decryptText } from "../utils/crypto.js";

/**
 * 資格情報を安全に登録または更新する
 */
export function registerCredential(serviceName: string, username: string, password: string): void {
  const cleanServiceName = serviceName.trim().toLowerCase();
  const cleanUsername = username.trim();

  // パスワードを aes-256-gcm で暗号化
  const { encrypted, iv, authTag } = encryptText(password);

  credentialRepo.saveCredential(cleanServiceName, cleanUsername, encrypted, iv, authTag);
}

/**
 * 特定のサービスの暗号化された資格情報をオンデマンドで復号して取得する
 */
export function getDecryptedCredential(
  serviceName: string
): { username: string; password: string } | null {
  const cleanServiceName = serviceName.trim().toLowerCase();
  const record = credentialRepo.getCredential(cleanServiceName);

  if (!record) {
    return null;
  }

  try {
    const password = decryptText(record.encrypted_password, record.iv, record.auth_tag);
    return {
      username: record.username,
      password,
    };
  } catch (error: any) {
    console.error(`資格情報 [${serviceName}] の復号中にエラーが発生しました:`, error.message);
    throw new Error("資格情報の復号に失敗しました。暗号キー（アクセスパスコード）が正しいか確認してください。");
  }
}

/**
 * 資格情報を完全に削除する
 */
export function deleteCredential(serviceName: string): boolean {
  const cleanServiceName = serviceName.trim().toLowerCase();
  return credentialRepo.deleteCredential(cleanServiceName);
}

/**
 * パスワード以外の登録済み資格情報インデックス一覧を取得する
 */
export function listCredentials() {
  return credentialRepo.listCredentials();
}
