import { getDb } from "./database.js";

// ─── Bot属性 関連テーブルのリポジトリ（bot_attributes_requirements.md §5） ────
// bot_mcp_links（MCPサーバー紐付け）/ bot_guilds（応答許可ギルド）/ bot_members（利用メンバー）。
// データ分離: 全クエリは bot_id を必須スコープとする（bot_id × guild_id × user_id 複合スコープ。
// architecture_v2.md §0-1 の例外パターン）。認可（owner検証等）は呼び出し側で行う。

// ─── BotとMCPサーバーの紐付け（要件 §4.5） ───────────────────────────────────

export interface BotMcpLinkRecord {
  id: number;
  bot_id: string;
  mcp_server_id: number;
  created_at: string;
}

export function linkMcpServer(botId: string, mcpServerId: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO bot_mcp_links (bot_id, mcp_server_id) VALUES (?, ?)`
    )
    .run(botId, mcpServerId);
  return result.changes > 0;
}

export function unlinkMcpServer(botId: string, mcpServerId: number): boolean {
  const db = getDb();
  return (
    db
      .prepare("DELETE FROM bot_mcp_links WHERE bot_id = ? AND mcp_server_id = ?")
      .run(botId, mcpServerId).changes > 0
  );
}

/** Botに紐付けられたMCPサーバーIDの一覧 */
export function listLinkedMcpServerIds(botId: string): number[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT mcp_server_id FROM bot_mcp_links WHERE bot_id = ? ORDER BY created_at ASC")
    .all(botId) as { mcp_server_id: number }[];
  return rows.map((r) => r.mcp_server_id);
}

// ─── 応答許可ギルド（要件 §4.3.3 / §6） ──────────────────────────────────────

export interface BotGuildRecord {
  bot_id: string;
  guild_id: string;
  created_at: string;
}

export function addAllowedGuild(botId: string, guildId: string): boolean {
  const db = getDb();
  return (
    db
      .prepare("INSERT OR IGNORE INTO bot_guilds (bot_id, guild_id) VALUES (?, ?)")
      .run(botId, guildId).changes > 0
  );
}

export function removeAllowedGuild(botId: string, guildId: string): boolean {
  const db = getDb();
  return (
    db
      .prepare("DELETE FROM bot_guilds WHERE bot_id = ? AND guild_id = ?")
      .run(botId, guildId).changes > 0
  );
}

export function listAllowedGuilds(botId: string): BotGuildRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM bot_guilds WHERE bot_id = ? ORDER BY created_at ASC")
    .all(botId) as BotGuildRecord[];
}

/** ギルド許可リストの照合（未許可ギルドでは応答も記録もしない防衛線） */
export function isGuildAllowed(botId: string, guildId: string): boolean {
  const db = getDb();
  return !!db
    .prepare("SELECT 1 FROM bot_guilds WHERE bot_id = ? AND guild_id = ?")
    .get(botId, guildId);
}

// ─── 利用メンバー（要件 §4.3.3: DiscordユーザーIDのみで管理） ────────────────

export interface BotMemberRecord {
  bot_id: string;
  guild_id: string;
  user_id: string;
  added_by: string;
  created_at: string;
}

export function addBotMember(
  botId: string,
  guildId: string,
  userId: string,
  addedBy: string
): boolean {
  const db = getDb();
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO bot_members (bot_id, guild_id, user_id, added_by) VALUES (?, ?, ?, ?)"
      )
      .run(botId, guildId, userId, addedBy).changes > 0
  );
}

export function removeBotMember(botId: string, guildId: string, userId: string): boolean {
  const db = getDb();
  return (
    db
      .prepare("DELETE FROM bot_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?")
      .run(botId, guildId, userId).changes > 0
  );
}

export function listBotMembers(botId: string, guildId?: string): BotMemberRecord[] {
  const db = getDb();
  if (guildId) {
    return db
      .prepare("SELECT * FROM bot_members WHERE bot_id = ? AND guild_id = ? ORDER BY created_at ASC")
      .all(botId, guildId) as BotMemberRecord[];
  }
  return db
    .prepare("SELECT * FROM bot_members WHERE bot_id = ? ORDER BY guild_id, created_at ASC")
    .all(botId) as BotMemberRecord[];
}

/** 利用メンバー判定（owner は常に暗黙メンバー。owner判定は呼び出し側で OR する） */
export function isBotMember(botId: string, guildId: string, userId: string): boolean {
  const db = getDb();
  return !!db
    .prepare("SELECT 1 FROM bot_members WHERE bot_id = ? AND guild_id = ? AND user_id = ?")
    .get(botId, guildId, userId);
}

export function countBotMembers(botId: string, guildId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM bot_members WHERE bot_id = ? AND guild_id = ?")
    .get(botId, guildId) as { cnt: number };
  return row.cnt;
}
