import { getDb } from "./database.js";
import { encryptText } from "../utils/crypto.js";

// ─── MCPサーバー拡張リポジトリ（§4.4） ───────────────────────────────────────
// user_id = NULL の行はシステムレベル登録（Adminのみ管理・全ユーザー利用可）。
// v5: owner（user_id）所有のまま「使わせる Bot を許可リスト(bot_mcp_access)で選ぶ」共有モデルへ移行。
// mcp_servers.bot_id 列は退役（参照しない。物理的には残置）。

export interface McpServerRecord {
  id: number;
  user_id: string | null;
  bot_id: string; // 退役（v4の占有スコープ。現在は未使用）
  name: string;
  endpoint_url: string;
  auth_credential_encrypted: string | null;
  auth_credential_iv: string | null;
  auth_credential_tag: string | null;
  tools_cache: string; // JSON: {name, description, inputSchema}[]
  tools_cache_updated: string | null;
  requires_confirmation: number;
  enabled: number;
  created_at: string;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export function addServer(
  userId: string | null,
  input: {
    name: string;
    endpointUrl: string;
    authCredential?: string;
    requiresConfirmation?: boolean;
  }
): McpServerRecord {
  const db = getDb();

  let enc: { encrypted: string; iv: string; authTag: string } | null = null;
  if (input.authCredential && input.authCredential.trim()) {
    enc = encryptText(input.authCredential.trim());
  }

  // bot_id は退役（NOT NULL DEFAULT 'system_default' が入る）。利用許可は bot_mcp_access で管理する。
  const result = db
    .prepare(
      `INSERT INTO mcp_servers
       (user_id, name, endpoint_url, auth_credential_encrypted, auth_credential_iv, auth_credential_tag, requires_confirmation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      input.name.trim(),
      input.endpointUrl.trim(),
      enc?.encrypted ?? null,
      enc?.iv ?? null,
      enc?.authTag ?? null,
      input.requiresConfirmation === false ? 0 : 1 // デフォルトは確認必須（§4.4.1）
    );
  return getServerById(Number(result.lastInsertRowid))!;
}

export function getServerById(id: number): McpServerRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRecord | undefined;
}

/**
 * ランタイム/管理画面用: Botが利用可能なMCPサーバー一覧（owner 横断・全許可分）。
 * = bot_mcp_access で許可されたサーバー（owner所有） + システムレベル登録（user_id IS NULL, 全Bot利用可）。
 *
 * 注意: 共有秘書(system_default)では全 owner の許可が混ざるため、ランタイムの会話解決では
 * 発話者でスコープする listServersGrantedToBotScoped() を使うこと（クロステナント露出防止）。
 * 本関数は単一所有Botのランタイムと、管理/表示UI（owner本人の画面）で使う。
 */
export function listServersGrantedToBot(botId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.* FROM mcp_servers s
         JOIN bot_mcp_access a ON a.mcp_server_id = s.id AND a.bot_id = ?
       UNION
       SELECT s.* FROM mcp_servers s WHERE s.user_id IS NULL
       ORDER BY created_at ASC`
    )
    .all(botId) as McpServerRecord[];
}

/**
 * ランタイムのセキュリティゲート: 発話者でスコープしたMCPサーバー一覧。
 * = 当該Botに「発話者(speakerUserId)が付与した」許可分（owner_id = speakerUserId）
 *   + システムレベル登録（user_id IS NULL, 全Bot利用可）。
 *
 * 共有秘書(system_default)は全ユーザーが会話するため、他人が付与した許可（他人の認証情報を
 * 抱えたMCPサーバー）が発話者の会話へ注入されないよう、発話者所有分のみに限定する。
 */
export function listServersGrantedToBotScoped(botId: string, speakerUserId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.* FROM mcp_servers s
         JOIN bot_mcp_access a ON a.mcp_server_id = s.id AND a.bot_id = ? AND a.owner_id = ?
       UNION
       SELECT s.* FROM mcp_servers s WHERE s.user_id IS NULL
       ORDER BY created_at ASC`
    )
    .all(botId, speakerUserId) as McpServerRecord[];
}

/**
 * 統合管理画面用: owner本人が登録したMCPサーバー一覧（許可付与の対象）。
 * システムレベルは listSystemServers() で別途取得する。
 */
export function listServersForOwner(userId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as McpServerRecord[];
}

// ─── 利用許可（bot_mcp_access） ──────────────────────────────────────────────

/** Botにサーバー利用を許可する（冪等）。owner_id = 許可を付与する owner（発話者スコープの鍵）。 */
export function grantMcpToBot(botId: string, ownerId: string, serverId: number): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO bot_mcp_access (bot_id, owner_id, mcp_server_id) VALUES (?, ?, ?)")
    .run(botId, ownerId, serverId);
}

/** Botからサーバー利用許可を取り消す。 */
export function revokeMcpFromBot(botId: string, ownerId: string, serverId: number): void {
  getDb()
    .prepare("DELETE FROM bot_mcp_access WHERE bot_id = ? AND owner_id = ? AND mcp_server_id = ?")
    .run(botId, ownerId, serverId);
}

/** 当該サーバーの利用を許可されている Bot ID 一覧（重複排除）。 */
export function listBotIdsForServer(serverId: number): string[] {
  return (
    getDb().prepare("SELECT DISTINCT bot_id FROM bot_mcp_access WHERE mcp_server_id = ?").all(serverId) as {
      bot_id: string;
    }[]
  ).map((r) => r.bot_id);
}

/**
 * Botが許可されているサーバーID一覧（owner所有分のみ。システムレベルは含めない）。
 * 管理/表示UI用（owner本人の許可状況を見せる）。owner を絞り込む場合は ownerId を渡す。
 */
export function listServerIdsForBot(botId: string, ownerId?: string): number[] {
  const db = getDb();
  const rows = (
    ownerId === undefined
      ? db
          .prepare("SELECT DISTINCT mcp_server_id FROM bot_mcp_access WHERE bot_id = ?")
          .all(botId)
      : db
          .prepare("SELECT mcp_server_id FROM bot_mcp_access WHERE bot_id = ? AND owner_id = ?")
          .all(botId, ownerId)
  ) as { mcp_server_id: number }[];
  return rows.map((r) => r.mcp_server_id);
}

/** Botが当該サーバーの利用を許可されているか（存在判定。owner 横断。システムレベルは別途 user_id IS NULL で判定）。 */
export function isMcpGrantedToBot(botId: string, serverId: number): boolean {
  return !!getDb()
    .prepare("SELECT 1 FROM bot_mcp_access WHERE bot_id = ? AND mcp_server_id = ? LIMIT 1")
    .get(botId, serverId);
}

/**
 * システムレベルのMCPサーバー一覧（user_id IS NULL。Admin管理・全ユーザー利用可）。
 */
export function listSystemServers(): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM mcp_servers WHERE user_id IS NULL ORDER BY created_at ASC")
    .all() as McpServerRecord[];
}

export function updateToolsCache(id: number, tools: McpToolDef[]): void {
  const db = getDb();
  db.prepare(
    `UPDATE mcp_servers SET tools_cache = ?, tools_cache_updated = datetime('now', 'localtime') WHERE id = ?`
  ).run(JSON.stringify(tools), id);
}

export function setEnabled(id: number, enabled: boolean): void {
  const db = getDb();
  db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

/**
 * MCPサーバーを削除する。
 * 本人登録分は本人のみ、システムレベル登録（user_id IS NULL）はAdminのみ削除可（§4.4.3）。
 */
export function deleteServer(id: number, requestingUserId: string, isAdminUser: boolean): boolean {
  const db = getDb();
  const server = getServerById(id);
  if (!server) return false;

  if (server.user_id === null) {
    if (!isAdminUser) return false;
  } else if (server.user_id !== requestingUserId) {
    return false;
  }

  const result = db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  return result.changes > 0;
}

/** tools_cache をパースして返す */
export function parseToolsCache(server: McpServerRecord): McpToolDef[] {
  try {
    const parsed = JSON.parse(server.tools_cache || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
