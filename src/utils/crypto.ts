import crypto from "node:crypto";
import { config } from "../config.js";

// 暗号鍵を導出するための固定ソルト
const SALT = "yuuka-seminar-accounting-salt";
let derivedKey: Buffer | null = null;

/**
 * adminToken から AES-256 用の 32 バイト暗号鍵を決定論的に導出する
 */
function getEncryptionKey(): Buffer {
  if (!derivedKey) {
    const masterKey = config.adminToken || "yuuka-seminar-2026";
    // scrypt を使用して安全に32バイト（256ビット）の鍵を導出
    derivedKey = crypto.scryptSync(masterKey, SALT, 32);
  }
  return derivedKey;
}

/**
 * プレーンな文字列を aes-256-gcm で暗号化する
 */
export function encryptText(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // GCM では 12 バイトの IV が推奨されます
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag,
  };
}

/**
 * aes-256-gcm で暗号化された文字列を復号する
 */
export function decryptText(encrypted: string, ivHex: string, authTagHex: string): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
