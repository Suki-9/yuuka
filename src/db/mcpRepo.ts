import { getDb } from "./database.js";
import { encryptText } from "../utils/crypto.js";

// ─── MCPサーバー拡張リポジトリ（§4.4） ───────────────────────────────────────
// user_id = NULL の行はシステムレベル登録（Adminのみ管理・全ユーザー利用可）。

export interface McpServerRecord {
  id: number;
  user_id: string | null;
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
 * ユーザーが利用可能なMCPサーバー一覧（本人登録分 + システムレベル登録分）
 */
export function listServersForUser(userId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM mcp_servers WHERE user_id = ? OR user_id IS NULL ORDER BY created_at ASC`
    )
    .all(userId) as McpServerRecord[];
}

/**
 * Botが利用可能なMCPサーバー一覧（bot_attributes_requirements.md §4.5）。
 * 「bot_mcp_links で紐付けられたサーバー + システムレベル(user_id IS NULL)サーバー」のみ。
 * 発話ユーザー個人のMCPサーバーは参照しない（秘書プリセットとの差分）。
 */
export function listServersForBot(botId: string): McpServerRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT DISTINCT s.* FROM mcp_servers s
       LEFT JOIN bot_mcp_links l ON l.mcp_server_id = s.id AND l.bot_id = ?
       WHERE l.id IS NOT NULL OR s.user_id IS NULL
       ORDER BY s.created_at ASC`
    )
    .all(botId) as McpServerRecord[];
}

/** 管理画面用の一覧（scope: 自分のもの or システムレベル） */
export function listServers(userId: string | null): McpServerRecord[] {
  const db = getDb();
  if (userId === null) {
    return db
      .prepare("SELECT * FROM mcp_servers WHERE user_id IS NULL ORDER BY created_at ASC")
      .all() as McpServerRecord[];
  }
  return db
    .prepare("SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId) as McpServerRecord[];
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
