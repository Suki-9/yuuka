import { decryptText } from "../utils/crypto.js";
import { assertSafeOutboundUrl } from "../utils/ssrfGuard.js";
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

/** MCP Tool が isError:true を返したことを表す（= トランスポート/セッション障害ではない）。
 *  これにより呼び出し側の再試行ロジックがツールエラーを再実行しないようにする。 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

/** セッション未確立/失効に起因するエラーか（= サーバーがリクエストを「実行せず」拒否したと判断できるか）を推定する。
 *  該当する場合のみ initialize し直して再試行する。タイムアウト/ネットワーク断/ツールエラーは含めない
 *  （それらは「実行済みかもしれない」ため副作用のある tools/call を二重実行しないよう再試行しない）。 */
function isSessionError(err: unknown): boolean {
  const msg = String((err as Error | undefined)?.message ?? "");
  return /\bHTTP 40[04]\b/.test(msg) || /session|not initialized|initializ/i.test(msg);
}

/** サーバーの認証ヘッダを構築する */
export function buildAuthHeader(server: McpServerRecord): Record<string, string> {
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

/** SSEレスポンスボディから当該リクエストの JSON-RPC レスポンスを抽出する簡易パーサ。
 *  expectedId が指定された場合は id 一致の応答を優先し（バッチ/サーバー発リクエストとの取り違え防止）、
 *  無ければ最後の result/error 応答にフォールバックする。 */
function parseSseBody(body: string, expectedId?: number | string | null): JsonRpcResponse | null {
  let last: JsonRpcResponse | null = null;
  let matched: JsonRpcResponse | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as JsonRpcResponse;
      // レスポンス（result/error持ち）のみ対象。通知・サーバー発リクエストはスキップ
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) {
        last = parsed;
        if (expectedId !== undefined && parsed.id === expectedId) matched = parsed;
      }
    } catch {
      // 部分的なdata行は無視
    }
  }
  return matched ?? last;
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
    // SSRF対策: 利用直前に宛先を再検証（DNSリバインディング含む内部到達を遮断）
    await assertSafeOutboundUrl(server.endpoint_url);
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

    const requestId = payload.id as number | undefined;
    let rpcResponse: JsonRpcResponse | null;
    if (contentType.includes("text/event-stream")) {
      rpcResponse = parseSseBody(bodyText, requestId);
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

/**
 * JSON-RPC 呼び出しを実行する。ステートレスサーバー（ywrk 等）では initialize 不要なので
 * まず直接実行し、セッション未確立/失効に起因するエラー（= サーバーが「実行せず」拒否）に
 * 限って一度だけ initialize し直して再試行する。
 *
 * 重要: タイムアウト・ネットワーク断・ツールエラー(McpToolError) では再試行しない。
 * これらは「サーバー側で実行済みかもしれない」ため、副作用のある tools/call を再実行すると
 * 二重更新を起こすからである。セッションエラーはサーバーが処理前に 4xx で弾くので再実行が安全。
 */
async function callRpc<T>(server: McpServerRecord, fn: () => Promise<T>): Promise<T> {
  try {
    // 既に initialize 済みなら sessionIds 経由でセッションヘッダが付く。
    // 未初期化でもステートレスサーバーはそのまま成功する。
    return await fn();
  } catch (err) {
    if (err instanceof McpToolError || !isSessionError(err)) throw err;
    // ステートフルサーバーのセッション未確立/失効。再初期化して一度だけ再試行する。
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
  return callRpc(server, async () => {
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
  return callRpc(server, async () => {
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
      // ツール側のエラー（トランスポート/セッション障害ではない）。callRpc は再試行しない。
      throw new McpToolError(joined || "MCP Tool がエラーを返しました");
    }
    return joined;
  });
}

// ─── MCPサーバー管理ページ統合（§4.4 拡張） ───────────────────────────────────
// 一部のMCPサーバーは endpoint_url と同一オリジンに管理ページ（HTML）を配信する。
//   - 有効判定: GET <origin>/dashboard/enable が 200 を返すか
//   - 本体    : GET <origin>/dashboard
// パス規約が変わる場合はここ（mcpOrigin / DASHBOARD_* ）だけを直せば済むよう集約する。

const DASHBOARD_ENABLE_PATH = "/dashboard/enable";
const DASHBOARD_PATH = "/dashboard";

/** endpoint_url のオリジン（scheme://host:port）を返す */
export function mcpOrigin(server: McpServerRecord): string {
  return new URL(server.endpoint_url).origin;
}

/** GET リクエストを Bearer 認証付き・タイムアウト付きで送る共通ヘルパ */
async function authedGet(server: McpServerRecord, url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // SSRF対策: 利用直前に宛先を再検証
    await assertSafeOutboundUrl(url);
    return await fetch(url, {
      method: "GET",
      headers: { ...buildAuthHeader(server) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * MCPサーバーが管理ページを提供しているか判定する。
 * GET <origin>/dashboard/enable が 200 のときのみ true（到達不可・非200は false）。
 */
export async function probeMcpDashboard(server: McpServerRecord): Promise<boolean> {
  try {
    const res = await authedGet(server, `${mcpOrigin(server)}${DASHBOARD_ENABLE_PATH}`);
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * MCPサーバーの管理ページ HTML を取得する（Bearer 認証注入）。
 */
export async function fetchMcpDashboardHtml(
  server: McpServerRecord
): Promise<{ status: number; html: string }> {
  const res = await authedGet(server, `${mcpOrigin(server)}${DASHBOARD_PATH}`);
  const html = await res.text();
  return { status: res.status, html };
}

const AKIZAKURA_CSS_URL = "https://akizakura.pages.dev/akizakura.css";
const AKIZAKURA_CACHE_TTL_MS = 60 * 60 * 1000; // 1時間
let akizakuraCache: { css: string; expiresAt: number } | null = null;

/**
 * akizakura.css（ywrk-mcp ダッシュボードの design system）を取得し、プロセス内に
 * キャッシュする（TTL 1時間）。ダッシュボードを Shadow DOM へ埋め込む際、:root の
 * デザイントークンはシャドウツリー内では一切マッチしない（:root はドキュメントルート
 * のみが対象）。そこでサーバー側で :root → :host へ書き換えてインライン化するために使う。
 * 取得失敗時は期限切れキャッシュ → null の順でフォールバックする（呼び出し側は
 * 元の <link> を残すことで「変数欠落の簡素表示だが機能はする」状態へ縮退する）。
 */
export async function fetchAkizakuraCss(): Promise<string | null> {
  const now = Date.now();
  if (akizakuraCache && akizakuraCache.expiresAt > now) return akizakuraCache.css;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(AKIZAKURA_CSS_URL, { method: "GET", signal: controller.signal });
    if (!res.ok) {
      console.error(`🔌 [MCP] akizakura.css の取得に失敗しました (HTTP ${res.status})`);
      return akizakuraCache?.css ?? null;
    }
    const css = await res.text();
    akizakuraCache = { css, expiresAt: now + AKIZAKURA_CACHE_TTL_MS };
    return css;
  } catch (err) {
    console.error(`🔌 [MCP] akizakura.css の取得でエラー: ${(err as Error).message}`);
    return akizakuraCache?.css ?? null;
  } finally {
    clearTimeout(timer);
  }
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
