import { getDb } from "./database.js";
import { encryptText } from "../utils/crypto.js";

// ─── MCPサーバー拡張リポジトリ（§4.4） ───────────────────────────────────────
// user_id = NULL の行はシステムレベル登録（Adminのみ管理・全ユーザー利用可）。
// スコープは (user_id, bot_id) 複合キー。user_id IS NULL はシステムレベルのため bot_id は無関係。

export interface McpServerRecord {
  id: number;
  user_id: string | null;
  bot_id: string;
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
  botId: string,
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

  const result = db
    .prepare(
      `INSERT INTO mcp_servers
       (user_id, bot_id, name, endpoint_url, auth_credential_encrypted, auth_credential_iv, auth_credential_tag, requires_confirmation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      botId,
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
 * ランタイム用: Botが利用可能なMCPサーバー一覧（Botスコープ分 + システムレベル登録分）。
 * (user_id = ownerUserId AND bot_id = botId) OR user_id IS NULL のサーバーを返す。
 */
export function listServersForBotScope(ownerUserId: string, botId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM mcp_servers WHERE (user_id = ? AND bot_id = ?) OR user_id IS NULL ORDER BY created_at ASC`
    )
    .all(ownerUserId, botId) as McpServerRecord[];
}

/**
 * 管理画面用: 指定 (user_id, bot_id) スコープのMCPサーバー一覧（本人登録分のみ）。
 * システムレベルは listSystemServers() で別途取得する。
 */
export function listServersForManagement(userId: string, botId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM mcp_servers WHERE user_id = ? AND bot_id = ? ORDER BY created_at ASC")
    .all(userId, botId) as McpServerRecord[];
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
