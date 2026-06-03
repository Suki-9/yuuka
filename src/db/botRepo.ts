import { getDb } from "./database.js";

export interface BotRecord {
  id: string;
  user_id: string;
  name: string;
  discord_token_encrypted: string | null;
  discord_token_iv: string | null;
  discord_token_tag: string | null;
  persona: string | null;
  gemini_api_key_encrypted: string | null;
  gemini_api_key_iv: string | null;
  gemini_api_key_tag: string | null;
  gemini_model: string;
  google_client_id: string | null;
  google_client_secret: string | null;
  google_refresh_token: string | null;
  google_calendar_id: string | null;
  google_calendars: string | null;
  google_drive_backup_enabled: number;
  google_drive_backup_folder_id: string | null;
  backup_cron: string;
  discord_username: string | null;
  discord_avatar_url: string | null;
  suspended: number;
  created_at: string;
  updated_at: string;
}

export interface BotGoogleConfig {
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  calendarId: string | null;
  calendars: string[];
}

export interface BotGeminiConfig {
  apiKeyEncrypted: string | null;
  apiKeyIv: string | null;
  apiKeyTag: string | null;
  model: string;
}

export interface BotDiscordConfig {
  tokenEncrypted: string | null;
  tokenIv: string | null;
  tokenTag: string | null;
  persona: string | null;
}

/**
 * 新しいBotを作成する
 */
export function createBot(
  botId: string,
  userId: string,
  name: string,
  persona: string | null = null
): BotRecord {
  const db = getDb();
  const runTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO bots (id, user_id, name, persona)
      VALUES (?, ?, ?, ?)
    `).run(botId, userId, name, persona);

    // アクセス制限テーブル（user_bot_access）に初期権限を追加
    db.prepare(`
      INSERT INTO user_bot_access (user_id, bot_id)
      VALUES (?, ?)
    `).run(userId, botId);
  });
  
  runTx();
  return getBotById(botId)!;
}

/**
 * IDでBotを取得する
 */
export function getBotById(botId: string): BotRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM bots WHERE id = ?").get(botId) as BotRecord | undefined;
}

/**
 * ユーザーがアクセス権限を持つBotの一覧を取得する
 */
export function listBotsForUser(userId: string): BotRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT DISTINCT b.* FROM bots b
    LEFT JOIN user_bot_access uba ON b.id = uba.bot_id
    WHERE b.user_id = ? OR uba.user_id = ? OR b.id = 'system_default'
    ORDER BY b.created_at ASC
  `).all(userId, userId) as BotRecord[];
}

/**
 * 全てのBotのID一覧を取得する
 */
export function listAllBotIds(): string[] {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM bots").all() as { id: string }[];
  return rows.map(r => r.id);
}

/**
 * Botを削除する
 */
export function deleteBot(botId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM bots WHERE id = ?").run(botId);
  return result.changes > 0;
}

/**
 * Botの基本設定と独自Discord設定を更新する
 */
export function updateBotSettings(
  botId: string,
  name: string,
  discordTokenEncrypted: string | null,
  discordTokenIv: string | null,
  discordTokenTag: string | null,
  persona: string | null
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE bots SET
      name = ?,
      discord_token_encrypted = ?,
      discord_token_iv = ?,
      discord_token_tag = ?,
      persona = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(name, discordTokenEncrypted, discordTokenIv, discordTokenTag, persona, botId);
  return result.changes > 0;
}

/**
 * BotのGemini設定を更新する
 */
export function updateBotGeminiSettings(
  botId: string,
  apiKeyEncrypted: string | null,
  apiKeyIv: string | null,
  apiKeyTag: string | null,
  model: string
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE bots SET
      gemini_api_key_encrypted = ?,
      gemini_api_key_iv = ?,
      gemini_api_key_tag = ?,
      gemini_model = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(apiKeyEncrypted, apiKeyIv, apiKeyTag, model, botId);
  return result.changes > 0;
}

/**
 * BotのGoogleカレンダー・OAuth設定を更新する
 */
export function updateBotGoogleSettings(
  botId: string,
  clientId: string | null,
  clientSecret: string | null,
  refreshToken: string | null,
  calendarId: string | null,
  calendars: string[]
): boolean {
  const db = getDb();
  
  const runTx = db.transaction(() => {
    db.prepare(`
      UPDATE bots SET
        google_client_id = ?,
        google_client_secret = ?,
        google_refresh_token = ?,
        google_calendar_id = ?,
        google_calendars = NULL,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(clientId, clientSecret, refreshToken, calendarId, botId);

    // 新しいカレンダーアクセス権限テーブル（bot_calendar_access）を更新
    db.prepare("DELETE FROM bot_calendar_access WHERE bot_id = ?").run(botId);
    
    const bot = getBotById(botId);
    if (bot) {
      const insertStmt = db.prepare("INSERT INTO bot_calendar_access (user_id, bot_id, calendar_id) VALUES (?, ?, ?)");
      for (const calId of calendars) {
        insertStmt.run(bot.user_id, botId, calId);
      }
    }
  });

  runTx();
  return true;
}

/**
 * BotのGoogle Driveバックアップ設定を更新する
 */
export function updateBotBackupSettings(
  botId: string,
  enabled: boolean,
  folderId: string | null,
  cron: string
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE bots SET
      google_drive_backup_enabled = ?,
      google_drive_backup_folder_id = ?,
      backup_cron = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(enabled ? 1 : 0, folderId, cron, botId);
  return result.changes > 0;
}

/**
 * BotのGemini設定のみ取得する
 */
export function getBotGeminiConfig(botId: string): BotGeminiConfig | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT gemini_api_key_encrypted, gemini_api_key_iv, gemini_api_key_tag, gemini_model
    FROM bots WHERE id = ?
  `).get(botId) as {
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
    model: row.gemini_model,
  };
}

/**
 * BotのGoogle OAuth設定のみ取得する
 */
export function getBotGoogleConfig(botId: string): BotGoogleConfig | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT google_client_id, google_client_secret, google_refresh_token,
           google_calendar_id
    FROM bots WHERE id = ?
  `).get(botId) as {
    google_client_id: string | null;
    google_client_secret: string | null;
    google_refresh_token: string | null;
    google_calendar_id: string | null;
  } | undefined;

  if (!row) return null;

  // bot_calendar_access から同期対象カレンダー一覧を取得
  const calendarRows = db.prepare("SELECT calendar_id FROM bot_calendar_access WHERE bot_id = ?").all(botId) as { calendar_id: string }[];
  const calendars = calendarRows.map(r => r.calendar_id);

  return {
    clientId: row.google_client_id,
    clientSecret: row.google_client_secret,
    refreshToken: row.google_refresh_token,
    calendarId: row.google_calendar_id,
    calendars,
  };
}

/**
 * Botの独自Discord Tokenおよびペルソナ設定のみを取得する
 */
export function getBotDiscordConfig(botId: string): BotDiscordConfig | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT discord_token_encrypted, discord_token_iv, discord_token_tag, persona
    FROM bots WHERE id = ?
  `).get(botId) as {
    discord_token_encrypted: string | null;
    discord_token_iv: string | null;
    discord_token_tag: string | null;
    persona: string | null;
  } | undefined;

  if (!row) return null;
  return {
    tokenEncrypted: row.discord_token_encrypted,
    tokenIv: row.discord_token_iv,
    tokenTag: row.discord_token_tag,
    persona: row.persona,
  };
}

/**
 * ユーザーのデフォルトBotを取得する（トークンが設定されていないBot）
 */
export function getDefaultBotForUser(userId: string): BotRecord | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM bots 
    WHERE user_id = ? AND (discord_token_encrypted IS NULL OR discord_token_encrypted = '') 
    LIMIT 1
  `).get(userId) as BotRecord | undefined;
}

/**
 * Discordから取得したユーザー名とアバターイメージURLをBotレコードに保存する
 */
export function updateBotDiscordProfile(
  botId: string,
  discordUsername: string | null,
  avatarUrl: string | null
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE bots SET
      discord_username = ?,
      discord_avatar_url = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(discordUsername, avatarUrl, botId);
  return result.changes > 0;
}

/**
 * Botの表示名とアバターURLを更新する（手動編集用）
 * discord_username も同時に更新することで Bot選択画面に即反映される
 */
export function updateBotProfile(
  botId: string,
  name: string,
  avatarUrl: string | null
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE bots SET
      name = ?,
      discord_username = ?,
      discord_avatar_url = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(name, name, avatarUrl, botId);
  return result.changes > 0;
}

// --- Admin モデレーション ---

/**
 * 全Bot一覧を取得する（Admin用）
 */
export function listAllBots(): BotRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM bots ORDER BY created_at ASC").all() as BotRecord[];
}

/**
 * Botを差し押さえる（停止状態にする）
 */
export function suspendBot(botId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE bots SET suspended = 1, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(botId);
  return result.changes > 0;
}

/**
 * Botの差し押さえを解除する
 */
export function unsuspendBot(botId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "UPDATE bots SET suspended = 0, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(botId);
  return result.changes > 0;
}

/**
 * Botが差し押さえ状態かどうか判定する
 */
export function isBotSuspended(botId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM bots WHERE id = ? AND suspended = 1 LIMIT 1"
  ).get(botId);
  return !!row;
}
