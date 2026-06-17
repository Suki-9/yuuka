import crypto from "node:crypto";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
  createBot,
  getBotById,
  listBotsForUser,
  hasBotAccess,
  deleteBot,
  updateBotDiscordProfile,
  updateBotProfile,
  createShareInvite,
  revokeShare,
  listSharesForBot,
} from "../../db/botRepo.js";
import { getUserByDiscordId, isAdmin } from "../../db/userRepo.js";
import { getPersonaById } from "../../db/personaRepo.js";
import { addAuditLog } from "../../db/auditRepo.js";
import {
  BOT_PRESETS,
  applyBotPreset,
  parseCapabilities,
  presetIdForCapabilities,
  getPresetDisplayName,
  invalidateBotCapabilitiesCache,
  isGuildAssistantBot,
  type BotPresetId,
} from "../../services/botCapabilities.js";
import type { BotRecord } from "../../db/botRepo.js";
import {
  stopCustomBot,
  client as defaultBotClient,
  customClients,
  sendShareInviteDM,
} from "../../bot.js";

// ─── Botインスタンス管理・共有 HTTPルート（§5.1, §5.2） ───────────────────────

/**
 * Botのランタイム稼働状態を、実際のメッセージルーティングモデルに合わせて判定する。
 *
 * liveness は必ず Client.isReady() で見る。discord.js は destroy / ゲートウェイ切断時に
 * readyTimestamp(=readyAt) をクリアしないため、readyAt は「一度でも接続したか」のスティッキー
 * フラグでしかなく、現在接続中かの判定には使えない（切断後も稼働中と誤判定する）。
 *
 * - 管理者に停止されたBot（suspended）は常にオフライン。
 * - system_default は共有デフォルト接続そのもの。
 * - 独自トークンを持つBotは専用クライアント（customClients）の状態に従う。
 *   client オブジェクトが存在＝起動を意図している（running）。実際の接続可否は isReady()。
 * - 独自トークン未設定の「秘書系」Botは専用接続を持たないが、リマインダー等の送信は
 *   notifier.ts resolveClientForUser() がデフォルトクライアントへフォールバックして届ける。
 *   よって稼働状態はデフォルトBotの接続に従い shared=true で示す（＝共有Botで送信）。
 * - 独自トークン未設定の「汎用モード(mcp_assistant)」Botはギルド常駐に専用トークンが必須で、
 *   デフォルト接続では一切機能しないため停止扱いとする。
 */
function botHealth(bot: BotRecord): { running: boolean; connected: boolean; shared: boolean } {
  if (bot.suspended === 1) return { running: false, connected: false, shared: false };
  if (bot.id === "system_default") {
    const up = defaultBotClient.isReady();
    return { running: up, connected: up, shared: false };
  }
  if (bot.discord_token_encrypted) {
    const c = customClients.get(bot.id);
    return { running: !!c, connected: !!c && c.isReady(), shared: false };
  }
  if (isGuildAssistantBot(bot.id)) {
    return { running: false, connected: false, shared: false };
  }
  const up = defaultBotClient.isReady();
  return { running: up, connected: up, shared: true };
}

/**
 * Bot一覧レスポンス用にレコードを整形する。
 * Bot専用Gemini APIキー・Discordトークンの暗号文はUIに不要かつ機密のため除外し、
 * 有無（has_*）と稼働状態（running/connected/shared）を付与する。
 */
function toBotView(bot: BotRecord) {
  const {
    gemini_api_key_encrypted, gemini_api_key_iv, gemini_api_key_tag,
    discord_token_encrypted, discord_token_iv, discord_token_tag,
    ...rest
  } = bot;
  const preset = presetIdForCapabilities(parseCapabilities(bot.capabilities));
  const health = botHealth(bot);
  return {
    ...rest,
    preset,
    preset_display_name: getPresetDisplayName(preset),
    has_gemini_key: !!(gemini_api_key_encrypted && gemini_api_key_iv && gemini_api_key_tag),
    has_token: !!discord_token_encrypted,
    running: health.running,
    connected: health.connected,
    shared: health.shared,
  };
}

export const botRoutes: RouteDef[] = [
  // ── Bot一覧・作成・削除 ──
  {
    method: "GET",
    path: "/api/bots",
    auth: "user",
    async handler(ctx) {
      sendJson(ctx.res, 200, {
        success: true,
        bots: listBotsForUser(ctx.user!.discordId).map(toBotView),
      });
    },
  },
  {
    method: "POST",
    path: "/api/bots",
    auth: "user",
    async handler(ctx) {
      const name = typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
      if (!name) {
        return sendJson(ctx.res, 400, { success: false, message: "Botの名前は必須です。" });
      }

      // プリセット選択（bot_attributes_requirements.md §4.1: 未選択時は secretary）
      const presetInput = typeof ctx.body.preset === "string" ? ctx.body.preset : "secretary";
      if (!(presetInput in BOT_PRESETS)) {
        return sendJson(ctx.res, 400, { success: false, message: "不明なプリセットです。" });
      }
      const preset = presetInput as BotPresetId;

      const botId = `bot_${crypto.randomUUID()}`;
      const bot = createBot(botId, ctx.user!.discordId, name);
      if (preset !== "secretary") {
        applyBotPreset(botId, preset);
        addAuditLog(ctx.user!.discordId, "bot.capabilities_change", botId, `create:${preset}`);
      }

      const created = getBotById(botId) ?? bot;
      sendJson(ctx.res, 200, {
        success: true,
        bot: toBotView(created),
        message:
          preset === "mcp_assistant"
            ? "Botを作成しました。汎用モードの利用にはBot専用のGemini APIキーの設定が必要です（Bot設定から設定してください）。"
            : "Botを作成しました。",
      });
    },
  },
  {
    method: "DELETE",
    path: "/api/bots",
    auth: "user",
    async handler(ctx) {
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      if (!botId) return sendJson(ctx.res, 400, { success: false, message: "Bot IDが必要です。" });
      if (botId.startsWith("bot_default_") || botId === "system_default") {
        return sendJson(ctx.res, 400, { success: false, message: "デフォルトのBotは削除できません。" });
      }

      // 所有者チェック
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== ctx.user!.discordId) {
        return sendJson(ctx.res, 403, { success: false, message: "Botの所有者のみが削除できます。" });
      }

      // 動作中のBotクライアントを停止
      stopCustomBot(botId);

      const ok = deleteBot(botId);
      invalidateBotCapabilitiesCache(botId);
      sendJson(ctx.res, 200, { success: ok, message: "Botを削除しました。" });
    },
  },

  // ── Discord プロフィール同期（§4.3.2 手動同期） ──
  {
    method: "POST",
    path: "/api/bots/sync-discord",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      if (!botId) return sendJson(ctx.res, 400, { success: false, message: "botId が必要です。" });
      if (!hasBotAccess(userId, botId)) {
        return sendJson(ctx.res, 403, { success: false, message: "アクセス権限がありません。" });
      }

      const botRecord = getBotById(botId);
      if (!botRecord) return sendJson(ctx.res, 404, { success: false, message: "Bot が見つかりません。" });

      // カスタムクライアントまたはデフォルトクライアントを使用してBot情報を取得
      let botUser: { username: string; displayAvatarURL: () => string } | null = null;
      const customClient = customClients.get(botId);
      if (customClient && customClient.user) {
        botUser = customClient.user;
      } else if (botRecord.discord_token_encrypted) {
        // トークンはあるがクライアント未起動の場合はエラー
        return sendJson(ctx.res, 400, { success: false, message: "Botクライアントが起動していません。先にBotを起動してください。" });
      } else if (defaultBotClient.user) {
        botUser = defaultBotClient.user;
      }

      if (!botUser) {
        return sendJson(ctx.res, 503, { success: false, message: "Discordクライアントが準備できていません。サーバーを確認してください。" });
      }

      const username = botUser.username;
      const avatarUrl = botUser.displayAvatarURL();
      updateBotDiscordProfile(botId, username, avatarUrl);

      sendJson(ctx.res, 200, {
        success: true,
        discord_username: username,
        discord_avatar_url: avatarUrl,
        message: `Discordプロフィールを同期しました: ${username}`,
      });
    },
  },

  // ── Botプロフィール編集 ──
  {
    method: "POST",
    path: "/api/bots/profile",
    auth: "user",
    async handler(ctx) {
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      if (!botId) return sendJson(ctx.res, 400, { success: false, message: "botId が必要です。" });
      if (botId === "system_default") {
        return sendJson(ctx.res, 403, { success: false, message: "デフォルトBotのプロフィールは変更できません。" });
      }

      const bot = getBotById(botId);
      if (!bot || bot.user_id !== ctx.user!.discordId) {
        return sendJson(ctx.res, 403, { success: false, message: "Botの所有者のみが変更できます。" });
      }

      const cleanName = typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
      if (!cleanName) return sendJson(ctx.res, 400, { success: false, message: "Botの名前は必須です。" });

      const avatarUrl = typeof ctx.body.avatarUrl === "string" ? ctx.body.avatarUrl.trim() : "";
      updateBotProfile(botId, cleanName, avatarUrl || undefined);
      sendJson(ctx.res, 200, { success: true, message: "Botのプロフィールを更新しました。" });
    },
  },

  // ── Bot共有（§5.2: 招待 → DM通知 → 承認フロー） ──
  {
    method: "GET",
    path: "/api/bots/shares",
    auth: "user",
    async handler(ctx) {
      const botId = ctx.url.searchParams.get("botId");
      if (!botId) return sendJson(ctx.res, 400, { success: false, message: "botId が必要です。" });
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== ctx.user!.discordId) {
        return sendJson(ctx.res, 403, { success: false, message: "Botの作成者のみが共有設定を閲覧できます。" });
      }
      const shares = listSharesForBot(botId).map((s) => ({
        ...s,
        shared_username: getUserByDiscordId(s.shared_user_id)?.username ?? null,
      }));
      sendJson(ctx.res, 200, { success: true, shares, recommended_persona_id: bot.recommended_persona_id });
    },
  },
  {
    method: "POST",
    path: "/api/bots/shares/invite",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const targetUserId = typeof ctx.body.targetUserId === "string" ? ctx.body.targetUserId.trim() : "";
      if (!botId || !targetUserId) {
        return sendJson(ctx.res, 400, { success: false, message: "botId と targetUserId が必要です。" });
      }

      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId) {
        return sendJson(ctx.res, 403, { success: false, message: "Botの作成者のみが共有招待を作成できます。" });
      }
      if (targetUserId === userId) {
        return sendJson(ctx.res, 400, { success: false, message: "自分自身を招待することはできません。" });
      }
      const targetUser = getUserByDiscordId(targetUserId);
      if (!targetUser) {
        return sendJson(ctx.res, 404, { success: false, message: "対象ユーザーが登録されていません。先にユーザー登録が必要です。" });
      }

      const share = createShareInvite(botId, userId, targetUserId);

      // 招待DMの送信（推奨ペルソナがあればその情報も通知 §5.2.2）
      let personaName: string | undefined;
      if (bot.recommended_persona_id) {
        const persona = getPersonaById(bot.recommended_persona_id);
        if (persona && persona.is_public === 1) personaName = persona.name;
      }
      const ownerName = getUserByDiscordId(userId)?.username ?? userId;
      const dmSent = await sendShareInviteDM(share.id, targetUserId, bot.name, ownerName, personaName);

      sendJson(ctx.res, 200, {
        success: true,
        share,
        message: dmSent
          ? `${targetUser.username} さんへ招待DMを送信しました。承認されるとアクセスが有効になります。`
          : `招待を作成しましたが、DM送信に失敗しました（Bot未起動またはDM拒否設定の可能性があります）。`,
      });
    },
  },
  {
    method: "POST",
    path: "/api/bots/shares/revoke",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      const targetUserId = typeof ctx.body.targetUserId === "string" ? ctx.body.targetUserId.trim() : "";
      if (!botId || !targetUserId) {
        return sendJson(ctx.res, 400, { success: false, message: "botId と targetUserId が必要です。" });
      }

      const bot = getBotById(botId);
      // Bot作成者 または Admin が取り消し可能（§5.3.2: 他ユーザーのBot共有設定の変更はAdmin可）
      if (!bot || (bot.user_id !== userId && !isAdmin(userId))) {
        return sendJson(ctx.res, 403, { success: false, message: "Botの作成者のみが共有を取り消せます。" });
      }

      const ok = revokeShare(botId, targetUserId);
      if (ok && bot.user_id !== userId) {
        addAuditLog(userId, "admin.share_revoke", `${botId}:${targetUserId}`);
      }
      sendJson(ctx.res, 200, {
        success: ok,
        message: ok ? "共有アクセスを取り消しました。" : "共有設定が見つかりません。",
      });
    },
  },
];
