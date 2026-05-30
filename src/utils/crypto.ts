import crypto from "node:crypto";

// 暗号鍵を導出するための固定ソルト
const SALT = "yuuka-seminar-accounting-salt";

// システムレベルの暗号鍵（起動時に生成、またはファイルから読み込み）
let systemKey: Buffer | null = null;

/**
 * システム全体で使用する AES-256 暗号鍵を取得する
 * マルチユーザー化に伴い、個別のadminTokenではなくシステムレベルの鍵を使用する
 */
function getEncryptionKey(): Buffer {
  if (!systemKey) {
    // システムレベルの秘密鍵をファイルまたは環境変数から取得
    const masterSecret = process.env.YUUKA_ENCRYPTION_SECRET;
    if (masterSecret) {
      systemKey = crypto.scryptSync(masterSecret, SALT, 32);
    } else {
      // フォールバック：固定値から導出（後方互換性維持）
      // TODO(security): 本番環境では YUUKA_ENCRYPTION_SECRET 環境変数を設定すること
      const fallbackKey = "yuuka-seminar-2026-system-key";
      console.warn("⚠️ YUUKA_ENCRYPTION_SECRET が未設定です。フォールバック鍵を使用しています。");
      systemKey = crypto.scryptSync(fallbackKey, SALT, 32);
    }
  }
  return systemKey;
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
