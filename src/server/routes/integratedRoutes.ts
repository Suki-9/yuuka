import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { listBotsOwnedBy, getBotById, isBotSuspended, hasBotAccess, type BotRecord } from "../../db/botRepo.js";
import { clearContext } from "../../db/messageLogRepo.js";
import { client, customClients, startCustomBot, stopCustomBot } from "../../bot.js";
import { parseCapabilities, presetIdForCapabilities } from "../../services/botCapabilities.js";
import {
  listServersForOwner,
  getServerById,
  grantMcpToBot,
  revokeMcpFromBot,
  listServerIdsForBot,
  parseToolsCache,
} from "../../db/mcpRepo.js";
import {
  grantCredentialToBot,
  revokeCredentialFromBot,
  listCredentialNamesForBot,
} from "../../db/credentialAccessRepo.js";
import * as secretService from "../../services/secretService.js";
import {
  listGoogleAccountsSafe,
  deleteGoogleAccount,
  setPrimaryGoogleAccount,
  updateGoogleCalendars,
  setBotGoogleAccount,
  clearBotGoogleAccount,
  getBotGoogleMode,
  getGoogleAccountById,
} from "../../db/googleAccountRepo.js";
import { fetchCalendarsForAccount, invalidateCalendarCacheForAccount } from "../../services/googleCalendarService.js";
import { addAuditLog } from "../../db/auditRepo.js";

// ─── Bot統合管理（owner単位の横断ページ, v5） ───────────────────────────────
// owner が「自分のBot」のヘルス/起動停止と、「自分のリソース（認証情報/MCP/Google）」の
// Bot別利用許可を一括管理する。アクセスは全て auth:"user" かつ owner本人スコープ。

/** botId が「リソース許可の対象」として有効か（owner所有 or 共有秘書 system_default）。 */
function isGrantTargetBot(userId: string, botId: string): BotRecord | null {
  if (botId === "system_default") return getBotById("system_default") ?? null;
  const bot = getBotById(botId);
  return bot && bot.user_id === userId ? bot : null;
}

/** Botのランタイム稼働状態。 */
function botRunStatus(botId: string): { running: boolean; connected: boolean } {
  if (botId === "system_default") {
    return { running: !!client.readyAt, connected: client.isReady() };
  }
  const c = customClients.get(botId);
  return { running: !!c, connected: !!c?.readyAt };
}

function presetOf(bot: BotRecord): string {
  return presetIdForCapabilities(parseCapabilities((bot as unknown as { capabilities?: string }).capabilities));
}

export const integratedRoutes: RouteDef[] = [
  // ── 統合オーバービュー（1コールでページ全体を構成） ──
  {
    method: "GET",
    path: "/api/integrated/overview",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;

      // 対象Bot = 共有秘書(system_default) + 所有Bot。system_default はヘルス表示のみ（起動停止不可）。
      const systemDefault = getBotById("system_default");
      const ownedBots = listBotsOwnedBy(userId).filter((b) => b.id !== "system_default");
      const botRecords: Array<{ bot: BotRecord; isSystemDefault: boolean }> = [];
      if (systemDefault) botRecords.push({ bot: systemDefault, isSystemDefault: true });
      for (const b of ownedBots) botRecords.push({ bot: b, isSystemDefault: false });

      const bots = botRecords.map(({ bot, isSystemDefault }) => {
        const status = botRunStatus(bot.id);
        return {
          id: bot.id,
          name: bot.name,
          is_system_default: isSystemDefault,
          preset: presetOf(bot),
          suspended: bot.suspended === 1,
          has_token: !!bot.discord_token_encrypted,
          running: status.running,
          connected: status.connected,
          discord_username: bot.discord_username ?? null,
          discord_avatar_url: bot.discord_avatar_url ?? null,
          // 許可サマリ（owner本人の許可分のみ。共有秘書では自分が付与した分だけを表示）
          granted_mcp_ids: listServerIdsForBot(bot.id, userId),
          granted_credentials: listCredentialNamesForBot(bot.id, userId),
          // google_setting: "primary"(既定) | "none"(連携なし) | <accountId number>
          google_setting: getBotGoogleMode(bot.id),
        };
      });

      // owner所有リソース
      const mcpServers = listServersForOwner(userId).map((s) => ({
        id: s.id,
        name: s.name,
        endpoint_url: s.endpoint_url,
        enabled: s.enabled === 1,
        has_auth: !!s.auth_credential_encrypted,
        tools: parseToolsCache(s).length,
      }));
      const credentials = secretService.listCredentialServices(userId).map((c) => ({
        service_name: c.service_name,
        username: c.username,
        url: c.url ?? null,
        updated_at: c.updated_at ?? null,
      }));
      const googleAccounts = listGoogleAccountsSafe(userId);

      sendJson(ctx.res, 200, {
        success: true,
        bots,
        mcpServers,
        credentials,
        googleAccounts,
      });
    },
  },

  // ── Bot 起動 ──（所有Botのみ。system_default は admin 管理のため不可） ──
  {
    method: "POST",
    path: "/api/integrated/bots/start",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId || botId === "system_default") {
        return sendJson(ctx.res, 403, { success: false, message: "このBotを操作する権限がありません。" });
      }
      if (isBotSuspended(botId)) {
        return sendJson(ctx.res, 409, { success: false, message: "このBotは管理者により停止されています。" });
      }
      if (!bot.discord_token_encrypted) {
        return sendJson(ctx.res, 409, { success: false, message: "Discordトークンが未設定です（Bot設定で登録してください）。" });
      }
      const ok = await startCustomBot(botId);
      addAuditLog(userId, "bot.owner_start", botId);
      const status = botRunStatus(botId);
      return sendJson(ctx.res, ok ? 200 : 502, {
        success: ok,
        message: ok ? "起動しました。" : "起動に失敗しました（トークンを確認してください）。",
        running: status.running,
        connected: status.connected,
      });
    },
  },

  // ── Bot 停止 ──（クライアント破棄のみ。トークンは保持し再起動可能） ──
  {
    method: "POST",
    path: "/api/integrated/bots/stop",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId || botId === "system_default") {
        return sendJson(ctx.res, 403, { success: false, message: "このBotを操作する権限がありません。" });
      }
      stopCustomBot(botId);
      addAuditLog(userId, "bot.owner_stop", botId);
      return sendJson(ctx.res, 200, { success: true, message: "停止しました。", running: false, connected: false });
    },
  },

  // ── Bot 再起動 ──（停止→起動。トークン更新なしで Discord 接続を貼り直す） ──
  {
    method: "POST",
    path: "/api/integrated/bots/restart",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId || botId === "system_default") {
        return sendJson(ctx.res, 403, { success: false, message: "このBotを操作する権限がありません。" });
      }
      if (isBotSuspended(botId)) {
        return sendJson(ctx.res, 409, { success: false, message: "このBotは管理者により停止されています。" });
      }
      if (!bot.discord_token_encrypted) {
        return sendJson(ctx.res, 409, { success: false, message: "Discordトークンが未設定です（Bot設定で登録してください）。" });
      }
      stopCustomBot(botId);
      const ok = await startCustomBot(botId);
      addAuditLog(userId, "bot.owner_restart", botId);
      const status = botRunStatus(botId);
      return sendJson(ctx.res, ok ? 200 : 502, {
        success: ok,
        message: ok ? "再起動しました。" : "再起動に失敗しました（トークンを確認してください）。",
        running: status.running,
        connected: status.connected,
      });
    },
  },

  // ── 会話履歴クリア ──
  // Redis のコンテキストキャッシュを削除し、context_floor（リセット境界）を記録する。
  // 永続ログ message_logs は削除しない（検索・監査用に保持。§7.1）。
  // スコープは (ログインユーザー, botId) の秘書会話のみ＝自分の会話だけに作用する。
  {
    method: "POST",
    path: "/api/integrated/bots/clear-history",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const bot = getBotById(botId);
      // 自分が会話できるBotのみ（system_default は共有秘書）。clearContext は (userId,botId) 自分の会話のみ操作。
      if (!bot || (botId !== "system_default" && !hasBotAccess(userId, botId))) {
        return sendJson(ctx.res, 403, { success: false, message: "このBotへのアクセス権がありません。" });
      }
      await clearContext(userId, botId);
      addAuditLog(userId, "conversation.clear", botId);
      return sendJson(ctx.res, 200, {
        success: true,
        message: "会話履歴をクリアしました（次のメッセージから新しい会話になります。永続ログは保持されます）。",
      });
    },
  },

  // ── 利用許可トグル: MCP ──
  {
    method: "POST",
    path: "/api/integrated/grants/mcp",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const serverId = Number(ctx.body.serverId);
      const granted = ctx.body.granted === true;
      if (!isGrantTargetBot(userId, botId)) {
        return sendJson(ctx.res, 403, { success: false, message: "対象Botへの権限がありません。" });
      }
      const server = Number.isInteger(serverId) ? getServerById(serverId) : undefined;
      if (!server || server.user_id !== userId) {
        return sendJson(ctx.res, 403, { success: false, message: "対象MCPサーバーの所有者ではありません。" });
      }
      // v7: owner_id = 許可を付与した呼び出し元。共有秘書(system_default)では発話者本人にのみ
      //     スコープされ、他ユーザーの会話へは漏れない（クロステナント露出の修正）。
      if (granted) grantMcpToBot(botId, userId, serverId);
      else revokeMcpFromBot(botId, userId, serverId);
      return sendJson(ctx.res, 200, { success: true });
    },
  },

  // ── 利用許可トグル: 認証情報 ──
  {
    method: "POST",
    path: "/api/integrated/grants/credential",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const rawService = typeof ctx.body.serviceName === "string" ? ctx.body.serviceName.trim().toLowerCase() : "";
      const granted = ctx.body.granted === true;
      if (!isGrantTargetBot(userId, botId)) {
        return sendJson(ctx.res, 403, { success: false, message: "対象Botへの権限がありません。" });
      }
      if (!rawService || !secretService.getDecryptedCredential(userId, rawService)) {
        return sendJson(ctx.res, 404, { success: false, message: "対象の認証情報が見つかりません。" });
      }
      if (granted) grantCredentialToBot(botId, userId, rawService);
      else revokeCredentialFromBot(botId, userId, rawService);
      return sendJson(ctx.res, 200, { success: true });
    },
  },

  // ── 使用Googleアカウント割当（per-bot。system_default は発話者primaryのため対象外） ──
  {
    method: "POST",
    path: "/api/integrated/grants/google",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      // mode: "primary"(既定=primaryフォールバック) | "none"(連携なし) | "account"(accountId指定)
      const mode = typeof ctx.body.mode === "string" ? ctx.body.mode : "primary";
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId || botId === "system_default") {
        return sendJson(ctx.res, 403, { success: false, message: "対象Botへの権限がありません（共有秘書は対象外）。" });
      }
      if (mode === "primary") {
        clearBotGoogleAccount(botId);
        return sendJson(ctx.res, 200, { success: true });
      }
      if (mode === "none") {
        setBotGoogleAccount(botId, null);
        return sendJson(ctx.res, 200, { success: true });
      }
      // mode === "account"
      const accountId = Number(ctx.body.accountId);
      const acct = Number.isInteger(accountId) ? getGoogleAccountById(accountId) : undefined;
      if (!acct || acct.user_id !== userId) {
        return sendJson(ctx.res, 403, { success: false, message: "対象Googleアカウントの所有者ではありません。" });
      }
      setBotGoogleAccount(botId, accountId);
      return sendJson(ctx.res, 200, { success: true });
    },
  },

  // ── Googleアカウント: primary変更 ──
  {
    method: "POST",
    path: "/api/integrated/google/accounts/primary",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const accountId = Number(ctx.body.accountId);
      const ok = Number.isInteger(accountId) && setPrimaryGoogleAccount(userId, accountId);
      return sendJson(ctx.res, ok ? 200 : 403, { success: ok });
    },
  },

  // ── Googleアカウント: 削除 ──
  {
    method: "POST",
    path: "/api/integrated/google/accounts/delete",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const accountId = Number(ctx.body.accountId);
      const ok = Number.isInteger(accountId) && deleteGoogleAccount(userId, accountId);
      if (ok) {
        invalidateCalendarCacheForAccount(accountId);
        addAuditLog(userId, "google.account_delete", String(accountId));
      }
      return sendJson(ctx.res, ok ? 200 : 403, { success: ok });
    },
  },

  // ── Googleアカウント: 同期対象カレンダー更新 ──
  {
    method: "POST",
    path: "/api/integrated/google/accounts/calendars",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const accountId = Number(ctx.body.accountId);
      const calendars = Array.isArray(ctx.body.calendars)
        ? (ctx.body.calendars as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const acct = Number.isInteger(accountId) ? getGoogleAccountById(accountId) : undefined;
      if (!acct || acct.user_id !== userId) {
        return sendJson(ctx.res, 403, { success: false });
      }
      updateGoogleCalendars(accountId, calendars);
      invalidateCalendarCacheForAccount(accountId);
      return sendJson(ctx.res, 200, { success: true });
    },
  },

  // ── Googleアカウント: 利用可能カレンダー一覧（選択UI用。Google APIから取得） ──
  {
    method: "GET",
    path: "/api/integrated/google/accounts/:id/calendars",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const accountId = Number(ctx.params.id);
      const acct = Number.isInteger(accountId) ? getGoogleAccountById(accountId) : undefined;
      if (!acct || acct.user_id !== userId) {
        return sendJson(ctx.res, 403, { success: false, calendars: [] });
      }
      const calendars = await fetchCalendarsForAccount(acct);
      sendJson(ctx.res, 200, { success: true, calendars });
    },
  },
];
