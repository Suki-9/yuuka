import { decryptText } from "../utils/crypto.js";
import {
  type McpServerRecord,
  type McpToolDef,
  updateToolsCache,
  getServerById,
} from "../db/mcpRepo.js";

// ─── MCP（Model Context Protocol）クライアント（§4.4） ──────────────────────
// MCP Streamable HTTP トランスポート（JSON-RPC 2.0 over HTTP POST）の最小実装。
// initialize → notifications/initialized → tools/list / tools/call を行う。
// 応答が SSE（text/event-stream）の場合は data: 行からJSONを抽出する。

const PROTOCOL_VERSION = "2025-03-26";
const REQUEST_TIMEOUT_MS = 15000;

// サーバーID → Mcp-Session-Id（initialize で発行された場合のみ保持）
const sessionIds = new Map<number, string>();
// 初期化済みサーバーID
const initializedServers = new Set<number>();

let nextRequestId = 1;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** サーバーの認証ヘッダを構築する */
function buildAuthHeader(server: McpServerRecord): Record<string, string> {
  if (
    !server.auth_credential_encrypted ||
    !server.auth_credential_iv ||
    !server.auth_credential_tag
  ) {
    return {};
  }
  try {
    const credential = decryptText(
      server.auth_credential_encrypted,
      server.auth_credential_iv,
      server.auth_credential_tag
    );
    return { Authorization: `Bearer ${credential}` };
  } catch (err) {
    console.error(`[MCP] サーバー ${server.name} の認証情報の復号に失敗しました:`, err);
    return {};
  }
}

/** SSEレスポンスボディから最後の JSON-RPC レスポンスを抽出する簡易パーサ */
function parseSseBody(body: string): JsonRpcResponse | null {
  let last: JsonRpcResponse | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      // レスポンス（result/error持ち）のみ対象。通知はスキップ
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
        last = parsed;
      }
    } catch {
      // 部分的なdata行は無視
    }
  }
  return last;
}

/** JSON-RPC リクエストを送信する（タイムアウト付き） */
async function rpcRequest(
  server: McpServerRecord,
  method: string,
  params: Record<string, unknown> | undefined,
  isNotification: boolean = false
): Promise<JsonRpcResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const payload: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  };
  if (!isNotification) {
    payload.id = nextRequestId++;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    ...buildAuthHeader(server),
  };
  const sessionId = sessionIds.get(server.id);
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  try {
    const response = await fetch(server.endpoint_url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // セッションIDの保持（initialize 応答で発行される場合がある）
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) {
      sessionIds.set(server.id, newSessionId);
    }

    if (isNotification) {
      return null; // 通知は応答ボディを期待しない（202等）
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const bodyText = await response.text();

    let rpcResponse: JsonRpcResponse | null;
    if (contentType.includes("text/event-stream")) {
      rpcResponse = parseSseBody(bodyText);
    } else {
      rpcResponse = bodyText ? (JSON.parse(bodyText) as JsonRpcResponse) : null;
    }

    if (rpcResponse?.error) {
      throw new Error(`MCP error ${rpcResponse.error.code}: ${rpcResponse.error.message}`);
    }
    return rpcResponse;
  } finally {
    clearTimeout(timer);
  }
}

/** initialize ハンドシェイクを実行する（未初期化の場合のみ） */
async function ensureInitialized(server: McpServerRecord): Promise<void> {
  if (initializedServers.has(server.id)) return;

  await rpcRequest(server, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "yuuka", version: "2.0" },
  });

  // initialized 通知（失敗は致命的でないため握る）
  try {
    await rpcRequest(server, "notifications/initialized", {}, true);
  } catch {}

  initializedServers.add(server.id);
}

/** セッション無効エラー時に初期化状態をリセットして1回だけ再試行するヘルパー */
async function withSessionRetry<T>(
  server: McpServerRecord,
  fn: () => Promise<T>
): Promise<T> {
  try {
    await ensureInitialized(server);
    return await fn();
  } catch (err) {
    // セッション切れ・未初期化系のエラーは一度だけ再初期化して再試行
    initializedServers.delete(server.id);
    sessionIds.delete(server.id);
    await ensureInitialized(server);
    return await fn();
  }
}

/**
 * MCPサーバーの提供Tool一覧を取得する（§4.4.2 手順2）
 */
export async function listTools(server: McpServerRecord): Promise<McpToolDef[]> {
  return withSessionRetry(server, async () => {
    const response = await rpcRequest(server, "tools/list", {});
    const result = response?.result as { tools?: unknown[] } | undefined;
    if (!result || !Array.isArray(result.tools)) return [];
    return result.tools
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({
        name: String(t.name ?? ""),
        description: t.description ? String(t.description) : undefined,
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : undefined,
      }))
      .filter((t) => t.name.length > 0);
  });
}

/**
 * MCP Tool を呼び出し、content のテキスト部分を連結して返す
 */
export async function callTool(
  server: McpServerRecord,
  toolName: string,
  args: Record<string, unknown>
): Promise<string> {
  return withSessionRetry(server, async () => {
    const response = await rpcRequest(server, "tools/call", {
      name: toolName,
      arguments: args,
    });
    const result = response?.result as
      | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      | undefined;

    if (!result) return "";

    const texts = (result.content || [])
      .filter((c) => c && (c.type === "text" || c.text !== undefined))
      .map((c) => c.text ?? "")
      .filter((t) => t.length > 0);

    const joined = texts.join("\n");
    if (result.isError) {
      throw new Error(joined || "MCP Tool がエラーを返しました");
    }
    return joined;
  });
}

/**
 * tools/list を実行して tools_cache を更新する
 * @returns 取得したTool数
 */
export async function refreshToolsCache(serverId: number): Promise<number> {
  const server = getServerById(serverId);
  if (!server) {
    throw new Error("MCPサーバーが見つかりません。");
  }
  const tools = await listTools(server);
  updateToolsCache(serverId, tools);
  console.log(`🔌 [MCP] ${server.name} のToolキャッシュを更新しました (${tools.length}件)`);
  return tools.length;
}
