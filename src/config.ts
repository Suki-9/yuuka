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

export const config = {
  discordToken: requireSetting("DISCORD_TOKEN"),
  geminiApiKey: requireSetting("GEMINI_API_KEY"),
  geminiModel: getSetting("GEMINI_MODEL", "gemini-3.1-flash-lite"),
  guildId: getSetting("GUILD_ID"),

  /** データベースファイルのパス */
  dbPath: getSetting("DB_PATH", "./data/yuuka.db"),

  /** リマインダーチェック間隔 (cron式) */
  reminderCron: getSetting("REMINDER_CRON", "* * * * *"),

  /** Googleカレンダー設定 */
  googleCalendarId: getSetting("GOOGLE_CALENDAR_ID"),
  googleCalendars: getSettingArray("GOOGLE_CALENDARS"),

  // A: サービスアカウント用
  googleServiceAccountEmail: getSetting("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  googlePrivateKey: getSetting("GOOGLE_PRIVATE_KEY") ? getSetting("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n") : "",

  // B: OAuth2用
  googleClientId: getSetting("GOOGLE_CLIENT_ID"),
  googleClientSecret: getSetting("GOOGLE_CLIENT_SECRET"),
  googleRefreshToken: getSetting("GOOGLE_REFRESH_TOKEN"),

  // ==========================================
  // 管理画面設定 (Dashboard Settings)
  // ==========================================
  /** 管理用画面のログインパスコード */
  adminToken: getSetting("ADMIN_TOKEN", "yuuka-seminar-2026"),

  /** 管理画面 of port number */
  port: parseInt(getSetting("PORT", "3000"), 10),

  /** 管理画面のバインドホスト (セキュリティのためデフォルトはローカルホスト) */
  host: getSetting("HOST", "127.0.0.1"),

  // ==========================================
  // GitHub 連携設定 (GitHub Integration Settings)
  // ==========================================
  /** GitHub Personal Access Token */
  githubToken: getSetting("GITHUB_TOKEN"),

  /** 上流（本家）のリポジトリ名 (owner/repo) */
  githubRepo: getSetting("GITHUB_REPO", "suki/yuuka"),

  /** フォークした自身のリポジトリ名 (owner/repo) */
  githubForkRepo: getSetting("GITHUB_FORK_REPO"),
} as const;

export function updateGoogleCalendarsInYaml(newCalendars: string[]): void {
  // YAMLインジェクション防止：カレンダーIDのサニタイズ
  const safeCalendars = newCalendars.map(cal => cal.replace(/["'\\\n\r\t]/g, ""));

  const content = fs.readFileSync(CONFIG_PATH, "utf-8");
  const lines = content.split(/\r?\n/);
  const newLines: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("GOOGLE_CALENDARS:")) {
      replaced = true;
      newLines.push("GOOGLE_CALENDARS:");
      for (const cal of safeCalendars) {
        newLines.push(`  - "${cal}"`);
      }
      i++;

      // Skip old calendar items
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trim();
        if (nextTrimmed.startsWith("-") || !nextTrimmed) {
          i++;
        } else {
          break;
        }
      }
    } else {
      newLines.push(line);
      i++;
    }
  }

  if (!replaced) {
    newLines.push("");
    newLines.push("GOOGLE_CALENDARS:");
    for (const cal of safeCalendars) {
      newLines.push(`  - "${cal}"`);
    }
  }

  fs.writeFileSync(CONFIG_PATH, newLines.join("\n"), "utf-8");

  // Reload memory parsedConfig
  try {
    parsedConfig = parseYaml(newLines.join("\n"));
  } catch(e) {}
}
