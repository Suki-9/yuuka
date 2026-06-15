import { randomBytes } from "node:crypto";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ── プロキシ用使い捨てトークン（Cookie が null-origin iframe から届かないため）──
// ダッシュボードHTML発行時に生成し、SPA の Authorization: Bearer で検証する。
interface ProxyTokenEntry {
  serverId: number;
  userId: string;
  expiresAt: number;
}
const proxyTokens = new Map<string, ProxyTokenEntry>();
const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000; // 1時間

function issueProxyToken(serverId: number, userId: string): string {
  // 期限切れトークンをまとめて掃除
  const now = Date.now();
  for (const [k, v] of proxyTokens) {
    if (v.expiresAt < now) proxyTokens.delete(k);
  }
  const token = randomBytes(32).toString("hex");
  proxyTokens.set(token, { serverId, userId, expiresAt: now + PROXY_TOKEN_TTL_MS });
  return token;
}

function consumeProxyToken(token: string, serverId: number): ProxyTokenEntry | null {
  const entry = proxyTokens.get(token);
  if (!entry) return null;
  if (entry.serverId !== serverId) return null;
  if (entry.expiresAt < Date.now()) {
    proxyTokens.delete(token);
    return null;
  }
  return entry;
}
import {
  addServer,
  listServers,
  getServerById,
  setEnabled,
  deleteServer,
  parseToolsCache,
  type McpServerRecord,
} from "../../db/mcpRepo.js";
import {
  refreshToolsCache,
  probeMcpDashboard,
  fetchMcpDashboardHtml,
  mcpOrigin,
  buildAuthHeader,
} from "../../services/mcpClient.js";
import { addAuditLog } from "../../db/auditRepo.js";

// ─── MCPサーバー管理 HTTPルート（§4.4） ──────────────────────────────────────
// scope:"system"（システムレベル登録）の操作はAdminのみ（§4.4.3）。

/** 認証情報・暗号化列を除いた安全なビュー */
function toSafeView(server: McpServerRecord) {
  return {
    id: server.id,
    scope: server.user_id === null ? "system" : "user",
    name: server.name,
    endpoint_url: server.endpoint_url,
    has_auth: !!server.auth_credential_encrypted,
    tools: parseToolsCache(server).map((t) => ({ name: t.name, description: t.description ?? "" })),
    tools_cache_updated: server.tools_cache_updated,
    requires_confirmation: server.requires_confirmation === 1,
    enabled: server.enabled === 1,
    created_at: server.created_at,
  };
}

/** 対象サーバーの操作権限を検証する（本人 or Admin+システムレベル） */
function canManage(server: McpServerRecord, userId: string, isAdmin: boolean): boolean {
  if (server.user_id === null) return isAdmin;
  return server.user_id === userId;
}

export const mcpRoutes: RouteDef[] = [
  // ── 一覧（自分の登録 + システムレベル） ──
  {
    method: "GET",
    path: "/api/mcp-servers",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const own = listServers(userId).map(toSafeView);
      const system = listServers(null).map(toSafeView);
      sendJson(ctx.res, 200, { success: true, servers: [...own, ...system] });
    },
  },

  // ── 追加（scope:"system" はAdminのみ §4.4.3） ──
  {
    method: "POST",
    path: "/api/mcp-servers/add",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const name = typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
      const endpointUrl = typeof ctx.body.endpointUrl === "string" ? ctx.body.endpointUrl.trim() : "";
      const authCredential =
        typeof ctx.body.authCredential === "string" ? ctx.body.authCredential : undefined;
      const requiresConfirmation = ctx.body.requiresConfirmation !== false;
      const scope = ctx.body.scope === "system" ? "system" : "user";

      if (!name || !endpointUrl) {
        return sendJson(ctx.res, 400, { success: false, message: "name と endpointUrl は必須です。" });
      }
      try {
        new URL(endpointUrl);
      } catch {
        return sendJson(ctx.res, 400, { success: false, message: "endpointUrl のURL形式が不正です。" });
      }
      if (scope === "system" && user.role !== "admin") {
        return sendJson(ctx.res, 403, { success: false, message: "システムレベルのMCPサーバー登録はAdminのみ可能です。" });
      }

      const server = addServer(scope === "system" ? null : user.discordId, {
        name,
        endpointUrl,
        authCredential,
        requiresConfirmation,
      });

      if (scope === "system") {
        addAuditLog(user.discordId, "admin.mcp_add", name, endpointUrl);
      }

      // 追加後に tools/list を試行してツール数を返す（§4.4.2 手順2）
      let toolCount = 0;
      let toolsMessage = "";
      try {
        toolCount = await refreshToolsCache(server.id);
        toolsMessage = `提供Tool ${toolCount} 件を取得しました。`;
      } catch (err) {
        toolsMessage = `登録しましたが tools/list の取得に失敗しました: ${(err as Error).message}`;
      }

      const fresh = getServerById(server.id)!;
      sendJson(ctx.res, 200, {
        success: true,
        server: toSafeView(fresh),
        message: `MCPサーバー「${name}」を登録しました。${toolsMessage}`,
      });
    },
  },

  // ── ツール一覧の再取得 ──
  {
    method: "POST",
    path: "/api/mcp-servers/refresh",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.body.id);
      const server = Number.isInteger(id) ? getServerById(id) : undefined;
      if (!server || !canManage(server, user.discordId, user.role === "admin")) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }
      try {
        const count = await refreshToolsCache(id);
        sendJson(ctx.res, 200, {
          success: true,
          server: toSafeView(getServerById(id)!),
          message: `Toolキャッシュを更新しました (${count}件)。`,
        });
      } catch (err) {
        sendJson(ctx.res, 502, { success: false, message: `tools/list の取得に失敗しました: ${(err as Error).message}` });
      }
    },
  },

  // ── 有効/無効の切り替え ──
  {
    method: "POST",
    path: "/api/mcp-servers/toggle",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.body.id);
      const enabled = ctx.body.enabled === true;
      const server = Number.isInteger(id) ? getServerById(id) : undefined;
      if (!server || !canManage(server, user.discordId, user.role === "admin")) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }
      setEnabled(id, enabled);
      sendJson(ctx.res, 200, {
        success: true,
        message: enabled ? "MCPサーバーを有効化しました。" : "MCPサーバーを無効化しました。",
      });
    },
  },

  // ── 削除 ──
  {
    method: "POST",
    path: "/api/mcp-servers/delete",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.body.id);
      if (!Number.isInteger(id)) {
        return sendJson(ctx.res, 400, { success: false, message: "id は必須です。" });
      }
      const server = getServerById(id);
      const ok = deleteServer(id, user.discordId, user.role === "admin");
      if (ok && server?.user_id === null) {
        addAuditLog(user.discordId, "admin.mcp_delete", server.name);
      }
      sendJson(ctx.res, 200, {
        success: ok,
        message: ok ? "MCPサーバーを削除しました。" : "MCPサーバーが見つからないか、削除権限がありません。",
      });
    },
  },

  // ── 管理ページ提供の有無を判定（<origin>/dashboard/enable が200か） ──
  {
    method: "GET",
    path: "/api/mcp-servers/:id/dashboard/status",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.params.id);
      const server = Number.isInteger(id) ? getServerById(id) : undefined;
      if (!server || !canManage(server, user.discordId, user.role === "admin")) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }
      const available = await probeMcpDashboard(server);
      sendJson(ctx.res, 200, { success: true, available });
    },
  },

  // ── 管理ページ HTML を取得（MCP_PATH をプロキシ経由に書き換え＋ダミートークン注入） ──
  {
    method: "GET",
    path: "/api/mcp-servers/:id/dashboard",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.params.id);
      const server = Number.isInteger(id) ? getServerById(id) : undefined;
      if (!server || !canManage(server, user.discordId, user.role === "admin")) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }
      if (!(await probeMcpDashboard(server))) {
        return sendJson(ctx.res, 404, {
          success: false,
          message: "このMCPサーバーは管理ページを提供していません。",
        });
      }
      try {
        const { status, html } = await fetchMcpDashboardHtml(server);
        if (status !== 200) {
          return sendJson(ctx.res, 502, {
            success: false,
            message: `管理ページの取得に失敗しました (HTTP ${status})。`,
          });
        }

        // MCP_PATH を /proxy/mcp/:id/mcp に書き換える（動的埋め込みではオリジン解決の問題がないため相対パスで十分）
        const proxyMcpPath = `/proxy/mcp/${id}/mcp`;
        let rewritten = html.replace(/var MCP_PATH = "[^"]*"/, `var MCP_PATH = "${proxyMcpPath}"`);

        // 使い捨てプロキシトークンを発行し、window 変数として注入する。
        // 動的埋め込みでは location.hash はユーザーの画面 URL を汚染するため使わない。
        // SPA の tokenFromHash() も window 変数を返すよう書き換える。
        const proxyToken = issueProxyToken(id, user.discordId);
        rewritten = rewritten.replace(
          /function tokenFromHash\(\)\s*\{[^}]*\}/,
          "function tokenFromHash() { return window.__mcpProxyToken__ || null; }"
        );
        const autoTokenScript = `<script>window.__mcpProxyToken__ = "${proxyToken}";</script>`;

        const withInjections = /<head[^>]*>/i.test(rewritten)
          ? rewritten.replace(/<head[^>]*>/i, (m) => `${m}${autoTokenScript}`)
          : `${autoTokenScript}${rewritten}`;

        sendJson(ctx.res, 200, { success: true, html: withInjections });
      } catch (err) {
        sendJson(ctx.res, 502, {
          success: false,
          message: `管理ページの取得に失敗しました: ${(err as Error).message}`,
        });
      }
    },
  },

  // ── MCPエンドポイント プロキシ（ダッシュボードのAPIコールをBearer認証付きで中継） ──
  // sandbox=null-origin の iframe は SameSite=Lax Cookie を送れないため、
  // ダッシュボード発行時に生成した使い捨てプロキシトークンで認証する。
  {
    method: "POST",
    path: "/proxy/mcp/:id/mcp",
    auth: "none",
    async handler(ctx) {
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id)) {
        return sendJson(ctx.res, 400, { success: false, message: "不正なサーバーIDです。" });
      }

      // Authorization: Bearer <proxyToken> を検証する
      const authHeader = (ctx.req.headers["authorization"] as string | undefined) ?? "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const tokenEntry = consumeProxyToken(bearerToken, id);
      if (!tokenEntry) {
        return sendJson(ctx.res, 401, { success: false, message: "プロキシトークンが無効または期限切れです。" });
      }

      const server = getServerById(id);
      if (!server) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }

      const accept = (ctx.req.headers["accept"] as string | undefined) ?? "application/json, text/event-stream";
      const controller = new AbortController();
      ctx.req.on("close", () => controller.abort());

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(server.endpoint_url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: accept,
            "MCP-Protocol-Version": "2025-03-26",
            ...buildAuthHeader(server),
          },
          body: new Uint8Array(ctx.rawBody),
          signal: controller.signal,
        });
      } catch (err) {
        if (!ctx.res.headersSent) {
          sendJson(ctx.res, 502, { success: false, message: `MCPサーバーへの接続に失敗しました: ${(err as Error).message}` });
        }
        return;
      }

      const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
      const responseHeaders: Record<string, string> = {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
      };
      const mcpSessionId = upstreamRes.headers.get("mcp-session-id");
      if (mcpSessionId) responseHeaders["mcp-session-id"] = mcpSessionId;

      ctx.res.writeHead(upstreamRes.status, responseHeaders);

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ctx.res.write(Buffer.from(value));
          }
        } catch {
          // クライアント切断等
        } finally {
          ctx.res.end();
        }
      } else {
        ctx.res.end();
      }
    },
  },
];
