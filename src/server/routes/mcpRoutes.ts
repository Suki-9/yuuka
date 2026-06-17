import { randomBytes } from "node:crypto";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ── プロキシ用トークン（ダッシュボードSPAの API 中継を認証する短命トークン）──
// ダッシュボードHTML発行時（Cookie認証済みユーザー）に生成し、SPA からの
// Authorization: Bearer で検証する。SPA は tools/list・tools/call を複数回呼ぶため
// 使い捨て（single-use）ではなく、TTL 内は再利用可能なセッショントークンである。
// ダッシュボードは隔離 iframe（不透明オリジン）内で動くため中継時に Cookie は届かない。
// よってトークンが認証の主体であり、{serverId, userId} に束縛し、中継のたびに発行ユーザーの
// 現在のロール・権限（canManage / enabled）を DB から再検証する（256bit乱数で不可推測、
// サーバー無効化・削除で即時失効）。
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
  listServersForOwner,
  listSystemServers,
  listBotIdsForServer,
  getServerById,
  setEnabled,
  deleteServer,
  parseToolsCache,
  type McpServerRecord,
} from "../../db/mcpRepo.js";
import { getUserByDiscordId } from "../../db/userRepo.js";
import {
  refreshToolsCache,
  probeMcpDashboard,
  fetchMcpDashboardHtml,
  fetchAkizakuraCss,
  mcpOrigin,
  buildAuthHeader,
} from "../../services/mcpClient.js";
import { addAuditLog } from "../../db/auditRepo.js";
import { config } from "../../config.js";
import { assertSafeOutboundUrl, BlockedUrlError } from "../../utils/ssrfGuard.js";

/**
 * iframe 用エラーページ（text/html）を返す。ダッシュボードは iframe の src として読み込まれるため、
 * 失敗時に JSON を返すと iframe 内に生 JSON が表示されてしまう。簡素な HTML を最小 CSP 付きで返す。
 */
function sendFrameError(res: import("node:http").ServerResponse, status: number, message: string): void {
  const safe = message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
  const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"></head><body style="font-family:system-ui,-apple-system,sans-serif;padding:24px;color:#52525b;font-size:0.9rem;">${safe}</body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self';",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

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
  // ── 一覧（owner本人の登録 + システムレベル）。読み取り＋許可Bot情報を返す。 ──
  // v5: 登録/許可は統合管理ページで行う。ここは owner所有サーバー（許可付与の対象）＋システムレベル。
  {
    method: "GET",
    path: "/api/mcp-servers",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const own = listServersForOwner(userId).map((s) => ({
        ...toSafeView(s),
        granted_bot_ids: listBotIdsForServer(s.id),
      }));
      const system = listSystemServers().map((s) => ({ ...toSafeView(s), granted_bot_ids: [] as string[] }));
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
      // SSRF対策: 形式チェックに加え、内部/予約レンジ・非http(s)スキームを登録時点で拒否する
      try {
        await assertSafeOutboundUrl(endpointUrl);
      } catch (err) {
        const msg = err instanceof BlockedUrlError ? err.message : "endpointUrl のURL形式が不正です。";
        return sendJson(ctx.res, 400, { success: false, message: msg });
      }
      if (scope === "system" && user.role !== "admin") {
        return sendJson(ctx.res, 403, { success: false, message: "システムレベルのMCPサーバー登録はAdminのみ可能です。" });
      }

      // v5: owner所有として登録（どのBotに使わせるかは bot_mcp_access の許可で別途設定）。
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

  // ── 管理ページ HTML を iframe 用に取得（MCP_PATH をプロキシ経由へ書き換え＋プロキシトークン注入）──
  // クライアントはこの URL を <iframe sandbox="allow-scripts" src> で読み込む。サンドボックスにより
  // iframe は不透明オリジンとなり、ダッシュボード（サードパーティMCPサーバー由来のSPA）の JS は
  // yuuka 本体の Cookie・localStorage・DOM・同一オリジンAPIへ一切アクセスできない（真の隔離）。
  // text/html を直接返す（real URL なので親 CSP を継承せず、このルート専用 CSP を付与できる）。
  {
    method: "GET",
    path: "/api/mcp-servers/:id/dashboard",
    auth: "user",
    async handler(ctx) {
      const user = ctx.user!;
      const id = Number(ctx.params.id);
      const server = Number.isInteger(id) ? getServerById(id) : undefined;
      if (!server || !canManage(server, user.discordId, user.role === "admin")) {
        return sendFrameError(ctx.res, 404, "MCPサーバーが見つかりません。");
      }
      if (!(await probeMcpDashboard(server))) {
        return sendFrameError(ctx.res, 404, "このMCPサーバーは管理ページを提供していません。");
      }
      try {
        const { status, html } = await fetchMcpDashboardHtml(server);
        if (status !== 200) {
          return sendFrameError(ctx.res, 502, `管理ページの取得に失敗しました (HTTP ${status})。`);
        }

        // iframe は不透明オリジンなので、その絶対オリジン（config.baseUrl 由来。未設定時は Host）を
        // 基準に各種URLを解決する。connect-src と MCP_PATH の両方でこの値を使い、確実に yuuka へ向ける。
        const selfOrigin = config.baseUrl
          ? new URL(config.baseUrl).origin
          : `http://${ctx.req.headers.host ?? "localhost"}`;

        // ダッシュボードが <base href="https://<mcp-origin>/dashboard/"> を持つ場合、相対URLが
        // MCPサーバー側オリジンへ解決されてしまう（埋め込み時の害）。除去して、相対URLは iframe
        // ドキュメント（yuuka オリジン）基準に解決させる。
        let rewritten = html.replace(/<base\b[^>]*>/i, "");

        // MCP_PATH をプロキシの「絶対URL」へ書き換える（<base> 除去後でも確実に yuuka へ向ける）。
        // String.replace は不一致時に元文字列をそのまま返すため、（base除去後の文字列を基準に）置換が
        // 起きたかを検証し、別リポジトリ(ywrk-mcp/dashboard.html)のフォーマットがドリフトした場合は
        // 壊れたページを 200 で返さず 502 で失敗させる。
        const proxyMcpUrl = `${selfOrigin}/proxy/mcp/${id}/mcp`;
        const beforeMcpPathRewrite = rewritten;
        rewritten = rewritten.replace(/var MCP_PATH = "[^"]*"/, `var MCP_PATH = "${proxyMcpUrl}"`);
        if (rewritten === beforeMcpPathRewrite) {
          console.error(`[MCP] ${server.name}: ダッシュボードHTMLの MCP_PATH 書き換えに失敗しました（フォーマット不一致）`);
          return sendFrameError(ctx.res, 502, "管理ページの形式が想定と異なるため表示できません（MCP_PATH）。");
        }

        // プロキシトークンを発行し window 変数として注入する（iframe の window 内に閉じる）。
        // location.hash は使わず、SPA の tokenFromHash() を window 変数を返すよう書き換える。
        const proxyToken = issueProxyToken(id, user.discordId);
        const beforeTokenRewrite = rewritten;
        rewritten = rewritten.replace(
          /function tokenFromHash\(\)\s*\{[^}]*\}/,
          "function tokenFromHash() { return window.__mcpProxyToken__ || null; }"
        );
        if (rewritten === beforeTokenRewrite) {
          console.error(`[MCP] ${server.name}: ダッシュボードHTMLの tokenFromHash 書き換えに失敗しました（フォーマット不一致）`);
          return sendFrameError(ctx.res, 502, "管理ページの形式が想定と異なるため表示できません（tokenFromHash）。");
        }
        const autoTokenScript = `<script>window.__mcpProxyToken__ = "${proxyToken}";</script>`;

        // akizakura.css（ダッシュボードの design system）をサーバー側でインライン化する。
        // iframe は独立ドキュメントなので :root はそのまま root 要素に効く（Shadow DOM 用の
        // :root→:host 書き換えは不要）。取得失敗時は元の <link> を残す。frame 用 CSP が
        // style-src で akizakura.pages.dev を許可しているため、その場合でも崩れず表示できる。
        const akizakuraCss = await fetchAkizakuraCss();
        if (akizakuraCss) {
          const akizakuraLinkRe = /<link\b[^>]*href="https:\/\/akizakura\.pages\.dev\/akizakura\.css"[^>]*>/i;
          if (akizakuraLinkRe.test(rewritten)) {
            rewritten = rewritten.replace(akizakuraLinkRe, `<style data-akizakura>${akizakuraCss}</style>`);
          } else {
            console.error(`[MCP] ${server.name}: akizakura の <link> が見つからず inline 化できませんでした`);
          }
        }

        // `<head ...>` 直後にトークン注入スクリプトを差し込む（`<header>` を誤検出しないよう境界を要求）。
        const headOpenTag = /<head(\s[^>]*)?>/i;
        const withInjections = headOpenTag.test(rewritten)
          ? rewritten.replace(headOpenTag, (m) => `${m}${autoTokenScript}`)
          : `${autoTokenScript}${rewritten}`;

        // このルート専用の CSP。iframe は不透明オリジンのため connect-src を 'self' ではなく
        // yuuka の絶対オリジン（上で算出した selfOrigin）で指定する（'self' は不透明オリジンに
        // 解決され /proxy に一致しないため）。
        const frameCsp =
          [
            "default-src 'none'",
            "base-uri 'none'",
            "script-src 'unsafe-inline'",
            "style-src 'unsafe-inline' https://akizakura.pages.dev https://fonts.googleapis.com",
            "font-src https://fonts.gstatic.com data:",
            `img-src 'self' data: ${selfOrigin}`,
            `connect-src ${selfOrigin}`,
            "frame-ancestors 'self'",
          ].join("; ") + ";";

        ctx.res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": frameCsp,
          "Cache-Control": "no-store",
        });
        ctx.res.end(withInjections);
      } catch (err) {
        sendFrameError(ctx.res, 502, `管理ページの取得に失敗しました: ${(err as Error).message}`);
      }
    },
  },

  // ── プロキシのCORSプリフライト（Authorization 等のカスタムヘッダのため必須） ──
  // 隔離 iframe は不透明オリジン（Origin: null）なので、POST の前にプリフライトが飛ぶ。
  // 認証主体は proxyToken（不可推測・serverId束縛・TTL・失効可）であり Cookie/Credentials は
  // 使わないため、ACAO:null かつ Allow-Credentials 無しの安全な組合せで応答する。
  {
    method: "OPTIONS",
    path: "/proxy/mcp/:id/mcp",
    auth: "none",
    async handler(ctx) {
      // 要求されたヘッダをそのまま許可リストへ反映する（SPA のヘッダ構成ドリフトに耐える）。
      // 認証は proxyToken が主体で Cookie 非依存のため、許可ヘッダの広さは安全性に影響しない。
      const reqHeaders =
        (ctx.req.headers["access-control-request-headers"] as string | undefined) ??
        "authorization, content-type, accept, mcp-protocol-version";
      ctx.res.removeHeader("Access-Control-Allow-Credentials");
      ctx.res.writeHead(204, {
        "Access-Control-Allow-Origin": "null",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": reqHeaders,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      ctx.res.end();
    },
  },

  // ── MCPエンドポイント プロキシ（ダッシュボードのAPIコールを Bearer 認証付きで中継） ──
  // ダッシュボードは sandbox="allow-scripts"（allow-same-origin 無し）の iframe 内で動く＝不透明
  // オリジンのため、Cookie セッションは届かない。認証は proxyToken 単独を主体とする:
  //   1. proxyToken: serverId への束縛＋短命TTL＋無効化即時失効（不可推測な256bit乱数）
  //   2. canManage / enabled: トークンに記録した発行ユーザーの現在のロール・権限を毎回再検証
  //      （降格・無効化の即時反映。ユーザーが消えていれば 403）
  // 不透明オリジンからのクロスオリジン fetch を許可するため ACAO:null を返す（Credentials 無し）。
  {
    method: "POST",
    path: "/proxy/mcp/:id/mcp",
    auth: "none",
    async handler(ctx) {
      // 不透明オリジン(Origin: null)からのレスポンス読み取りを許可。Cookie 不使用なので
      // Allow-Credentials は付けない（ACAO:null + 資格情報無し の安全な組合せ）。
      // server.ts のCORS処理が先に資格情報付きヘッダを立てている可能性があるため明示的に除去し、
      // ACAO:null と Allow-Credentials:true が同居する不正な組合せを防ぐ。
      ctx.res.setHeader("Access-Control-Allow-Origin", "null");
      ctx.res.removeHeader("Access-Control-Allow-Credentials");
      ctx.res.setHeader("Vary", "Origin");

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
      // トークン発行ユーザーの現在の権限・ロールを DB から引き直して再検証する（Cookie は届かないため、
      // 発行時に束縛した userId を信頼の起点とする。発行後にユーザーが消えていれば拒否）。
      const tokenUser = getUserByDiscordId(tokenEntry.userId);
      if (!tokenUser) {
        return sendJson(ctx.res, 403, { success: false, message: "トークン発行ユーザーが存在しません。" });
      }

      const server = getServerById(id);
      if (!server) {
        return sendJson(ctx.res, 404, { success: false, message: "MCPサーバーが見つかりません。" });
      }
      // 発行後に権限・有効状態が変化していないか毎回再検証する（降格・無効化の即時反映）
      if (!canManage(server, tokenUser.discord_id, tokenUser.role === "admin")) {
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
        // SSRF対策: 中継直前に宛先を再検証（DNSリバインディング含む内部到達を遮断）
        await assertSafeOutboundUrl(server.endpoint_url);
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
