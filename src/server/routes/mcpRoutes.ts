import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
  addServer,
  listServers,
  getServerById,
  setEnabled,
  deleteServer,
  parseToolsCache,
  type McpServerRecord,
} from "../../db/mcpRepo.js";
import { refreshToolsCache } from "../../services/mcpClient.js";
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
];
