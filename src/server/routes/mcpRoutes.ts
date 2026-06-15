import { randomBytes } from "node:crypto";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ── プロキシ用トークン（ダッシュボードSPAの API 中継を認証する短命トークン）──
// ダッシュボードHTML発行時（Cookie認証済みユーザー）に生成し、SPA からの
// Authorization: Bearer で検証する。SPA は tools/list・tools/call を複数回呼ぶため
// 使い捨て（single-use）ではなく、TTL 内は再利用可能なセッショントークンである。
// 中継時にはトークンに加えて Cookie セッション（発行ユーザー）も照合する（漏洩耐性）。
interface ProxyTokenEntry {
  serverId: number;
  userId: string;
  expiresAt: number;
}
const proxyTokens = new Map<string, ProxyTokenEntry>();
const PROXY_TOKEN_TTL_MS = 60 * 60 * 1000; // 1時間

/** 期限切れトークンをまとめて掃除する（発行・検証の双方で呼び、放置による肥大を防ぐ） */
function sweepExpiredProxyTokens(now: number): void {
  for (const [k, v] of proxyTokens) {
    if (v.expiresAt < now) proxyTokens.delete(k);
  }
}

function issueProxyToken(serverId: number, userId: string): string {
  const now = Date.now();
  sweepExpiredProxyTokens(now);
  const token = randomBytes(32).toString("hex");
  proxyTokens.set(token, { serverId, userId, expiresAt: now + PROXY_TOKEN_TTL_MS });
  return token;
}

/** プロキシトークンを検証する（serverId 一致・未失効）。失効分はここでも掃除する。 */
function validateProxyToken(token: string, serverId: number): ProxyTokenEntry | null {
  const now = Date.now();
  sweepExpiredProxyTokens(now);
  const entry = proxyTokens.get(token);
  if (!entry) return null;
  if (entry.serverId !== serverId) return null;
  if (entry.expiresAt < now) {
    proxyTokens.delete(token);
    return null;
  }
  return entry;
}

/** 指定サーバーのプロキシトークンを即時失効させる（無効化・削除時に呼ぶ） */
function revokeProxyTokensForServer(serverId: number): void {
  for (const [k, v] of proxyTokens) {
    if (v.serverId === serverId) proxyTokens.delete(k);
  }
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
      // 無効化したら、発行済みプロキシトークンを即時失効させる（開きっぱなしの
      // ダッシュボードが無効化後も中継し続けるのを防ぐ）。
      if (!enabled) revokeProxyTokensForServer(id);
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
      if (ok) {
        revokeProxyTokensForServer(id);
        if (server?.user_id === null) {
          addAuditLog(user.discordId, "admin.mcp_delete", server.name);
        }
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

        // MCP_PATH を /proxy/mcp/:id/mcp に書き換える（iframe srcdoc は yuuka と同一オリジンのため相対パスで十分）。
        // String.replace は不一致時に元文字列をそのまま返すため、置換が起きたかを明示的に検証し、
        // 別リポジトリ(ywrk-mcp/dashboard.html)のフォーマットがドリフトした場合は壊れたページを
        // 200 で返さず 502 で失敗させる（サイレント破損の防止）。
        const proxyMcpPath = `/proxy/mcp/${id}/mcp`;
        let rewritten = html.replace(/var MCP_PATH = "[^"]*"/, `var MCP_PATH = "${proxyMcpPath}"`);
        if (rewritten === html) {
          console.error(`[MCP] ${server.name}: ダッシュボードHTMLの MCP_PATH 書き換えに失敗しました（フォーマット不一致）`);
          return sendJson(ctx.res, 502, {
            success: false,
            message: "管理ページの形式が想定と異なるため表示できません（MCP_PATH）。",
          });
        }

        // プロキシトークンを発行し、window 変数として注入する。
        // location.hash はユーザーの画面 URL を汚染するため使わず、SPA の tokenFromHash() を
        // window 変数を返すよう書き換える。
        const proxyToken = issueProxyToken(id, user.discordId);
        const beforeTokenRewrite = rewritten;
        rewritten = rewritten.replace(
          /function tokenFromHash\(\)\s*\{[^}]*\}/,
          "function tokenFromHash() { return window.__mcpProxyToken__ || null; }"
        );
        if (rewritten === beforeTokenRewrite) {
          console.error(`[MCP] ${server.name}: ダッシュボードHTMLの tokenFromHash 書き換えに失敗しました（フォーマット不一致）`);
          return sendJson(ctx.res, 502, {
            success: false,
            message: "管理ページの形式が想定と異なるため表示できません（tokenFromHash）。",
          });
        }
        const autoTokenScript = `<script>window.__mcpProxyToken__ = "${proxyToken}";</script>`;

        // `<head ...>` のみにマッチさせる（`<header>` を誤って拾わないよう空白/`>` を境界に要求）。
        const headOpenTag = /<head(\s[^>]*)?>/i;
        const withInjections = headOpenTag.test(rewritten)
          ? rewritten.replace(headOpenTag, (m) => `${m}${autoTokenScript}`)
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

  // ── MCPエンドポイント プロキシ（ダッシュボードのAPIコールを Bearer 認証付きで中継） ──
  // ダッシュボードは yuuka と同一オリジンの iframe(srcdoc) 内で動くため Cookie セッションが届く。
  // そのため auth:"user"（セッション必須）に加えて、発行時のプロキシトークンを併用する:
  //   1. proxyToken: serverId への束縛＋短命TTL
  //   2. Cookie セッション: 実際の発話者が「トークン発行ユーザー本人」であることの照合
  //   3. canManage / enabled: 発行後の権限・有効状態の変化を毎回再検証
  {
    method: "POST",
    path: "/proxy/mcp/:id/mcp",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.params.id);
      if (!Number.isInteger(id)) {
        return sendJson(ctx.res, 400, { success: false, message: "不正なサーバーIDです。" });
      }

      // Authorization: Bearer <proxyToken> を検証する
      const authHeader = (ctx.req.headers["authorization"] as string | undefined) ?? "";
      const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const tokenEntry = validateProxyToken(bearerToken, id);
      if (!tokenEntry) {
        return sendJson(ctx.res, 401, { success: false, message: "プロキシトークンが無効または期限切れです。" });
      }
      // トークン発行ユーザーと現在のセッションユーザーが一致すること（漏洩トークンの横取り防止）
      if (user.discordId !== tokenEntry.userId) {
        return sendJson(ctx.res, 403, { success: false, message: "このプロキシトークンを利用する権限がありません。" });
      }

      const server = getServerById(id);
      if (!server) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }
      // 発行後に権限・有効状態が変化していないか毎回再検証する（降格・無効化の即時反映）
      if (!canManage(server, user.discordId, user.role === "admin")) {
        return sendJson(ctx.res, 403, { success: false, message: "このMCPサーバーを操作する権限がありません。" });
      }
      if (server.enabled !== 1) {
        return sendJson(ctx.res, 403, { success: false, message: "このMCPサーバーは無効化されています。" });
      }

      const accept = (ctx.req.headers["accept"] as string | undefined) ?? "application/json, text/event-stream";
      const controller = new AbortController();
      // クライアント切断は req ではなく res の 'close' で検知する（ボディは handler 到達前に
      // 読み切られており req の 'close' は発火しないため。writableFinished で正常完了と区別）。
      ctx.res.on("close", () => {
        if (!ctx.res.writableFinished) controller.abort();
      });

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
      // 同一オリジン中継のため CORS ヘッダーは付けない（ACAO:* と server.ts の
      // Access-Control-Allow-Credentials:true が同居する不正な組み合わせを避ける）。
      const responseHeaders: Record<string, string> = {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
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
        } catch (err) {
          // クライアント切断による中断（abort）は正常系として無視する。
          // 上流の途中エラーは握りつぶさず、レスポンスを異常終了させて
          // 「200 + 切り詰めボディ」をクライアントへ渡さないようにする。
          if (!controller.signal.aborted && !ctx.res.destroyed) {
            console.error(`[MCP proxy] ${server.name} のストリーム転送中にエラー:`, (err as Error).message);
            ctx.res.destroy(err as Error);
          }
        } finally {
          if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.end();
        }
      } else {
        ctx.res.end();
      }
    },
  },
];
