import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./utils/yamlParser.js";

// config.yaml の読み込みとパース
const CONFIG_PATH = path.resolve(process.cwd(), "config.yaml");
let parsedConfig: Record<string, string | string[]> = {};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    parsedConfig = parseYaml(content);
  } catch (err) {
    console.error("⚠️ config.yaml の読み込みに失敗しました。デフォルト設定または環境変数を使用します。:", err);
  }
} else {
  console.warn("⚠️ config.yaml が見つかりません。環境変数を使用します。");
}

function getSetting(key: string, defaultValue: string = ""): string {
  const val = parsedConfig[key] ?? process.env[key] ?? defaultValue;
  if (Array.isArray(val)) {
    return val.join(",");
  }
  return val;
}

function getSettingArray(key: string, defaultValue: string[] = []): string[] {
  const val = parsedConfig[key] ?? process.env[key];
  if (!val) return defaultValue;
  if (Array.isArray(val)) {
    return val;
  }
  return val.split(",").map(id => id.trim()).filter(Boolean);
}

function requireSetting(key: string): string {
  const value = getSetting(key);
  if (!value) {
    throw new Error(`設定項目 "${key}" が定義されていません。config.yaml または環境変数を確認してください。`);
  }
  return value;
}

/**
 * システム全体の設定（全ユーザー共有）
 * ユーザー別設定はDBから取得する（userRepo.ts参照）
 */
export const config = {

  /** データベースファイルのパス */
  dbPath: getSetting("DB_PATH", "./data/yuuka.db"),

  /**
   * 保存時暗号化のマスターシークレット（§6.2）
   * 環境変数 YUUKA_ENCRYPTION_SECRET で設定する（.env / systemd の Environment 等）。
   * 後方互換のため SECRET_KEY と config.yaml も受け付けるが、
   * config.yaml の空文字エントリが環境変数を隠さないよう環境変数を優先する。
   * ローテーション中のみ書き換わるため mutable。
   */
  secretKey:
    process.env.YUUKA_ENCRYPTION_SECRET ||
    process.env.SECRET_KEY ||
    getSetting("YUUKA_ENCRYPTION_SECRET", "") ||
    getSetting("SECRET_KEY", ""),

  /** YUUKA_ENCRYPTION_SECRET ローテーション用の新キー（設定されている場合、起動時に再暗号化が走る） */
  secretKeyNew:
    process.env.YUUKA_ENCRYPTION_SECRET_NEW ||
    process.env.SECRET_KEY_NEW ||
    getSetting("YUUKA_ENCRYPTION_SECRET_NEW", "") ||
    getSetting("SECRET_KEY_NEW", ""),

  /** 返信チェーン解決の最大遡り深度（§3.1.4 無限ループ防止） */
  replyChainMaxDepth: parseInt(getSetting("REPLY_CHAIN_MAX_DEPTH", "10"), 10),

  /** セッショントークンの有効期限（日数、§5.4.2） */
  sessionTtlDays: parseInt(getSetting("SESSION_TTL_DAYS", "7"), 10),

  /** 初期Adminに昇格するDiscordユーザーID（§5.3.1。カンマ区切り、任意） */
  adminDiscordIds: getSettingArray("ADMIN_DISCORD_IDS"),

  /** Redis接続用URL */
  redisUrl: getSetting("REDIS_URL", "redis://127.0.0.1:6379"),

  /** リマインダーチェック間隔 (cron式) */
  reminderCron: getSetting("REMINDER_CRON", "* * * * *"),

  /** 管理画面サーバーのポート */
  port: parseInt(getSetting("PORT", "3000"), 10),

  /** 管理画面のバインドホスト (セキュリティのためデフォルトはローカルホスト) */
  host: getSetting("HOST", "127.0.0.1"),

  /** 招待コード一覧（起動時にDBに投入される） */
  inviteCodes: getSettingArray("INVITE_CODES"),

  /** Google OAuth Client ID (システムデフォルト) */
  googleClientId: getSetting("GOOGLE_CLIENT_ID", ""),

  /** Google OAuth Client Secret (システムデフォルト) */
  googleClientSecret: getSetting("GOOGLE_CLIENT_SECRET", ""),

  /** 外部公開用ベースURL */
  baseUrl: getSetting("BASE_URL", ""),

  /** 一般公開のプライバシーポリシーURL */
  privacyPolicyUrl: getSetting("PRIVACY_POLICY_URL", ""),

  /** 一般公開の利用規約URL */
  termsUrl: getSetting("TERMS_URL", ""),

  /** Google Search Console 所有権確認トークン */
  googleSiteVerification: getSetting("GOOGLE_SITE_VERIFICATION", ""),

};
