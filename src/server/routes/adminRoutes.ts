import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { config } from "../../config.js";
import { getDb } from "../../db/database.js";
import {
  getUserByDiscordId,
  listAllUsers,
  updateUserRole,
  deleteUser,
} from "../../db/userRepo.js";
import { destroyAllSessionsForUser } from "../../services/sessionService.js";
import { addAuditLog, listAuditLogs, countAuditLogs } from "../../db/auditRepo.js";
import { listAllBots, suspendBot, unsuspendBot } from "../../db/botRepo.js";
import { stopCustomBot, customClients, restartDefaultBot } from "../../bot.js";
import { listInviteCodes, createInviteCode } from "../../db/inviteRepo.js";
import { encryptText } from "../../utils/crypto.js";
import { getSystemSetting, setSystemSetting } from "../../db/systemSettingsRepo.js";

// ─── Admin 管理 HTTPルート（§5.3。全ルート auth:"admin"） ────────────────────
// 注意: ロール変更・ユーザー削除時に destroyAllSessionsForUser を呼ぶことで、
// セッション内ロールの陳腐化を防いでいる（registry の auth:"admin" 判定が有効に保たれる前提）。

export const adminRoutes: RouteDef[] = [
  // ── デフォルトBotのトークン更新 ──
  {
    method: "POST",
    path: "/api/admin/default-bot/token",
    auth: "admin",
    async handler(ctx) {
      const token = typeof ctx.body.token === "string" ? ctx.body.token.trim() : "";
      if (!token) {
        return sendJson(ctx.res, 400, { success: false, message: "トークンを入力してください。" });
      }

      // 1. システムデフォルトBotトークンの暗号化と保存
      const enc = encryptText(token);
      const db = getDb();
      db.prepare(`
        INSERT INTO bots (id, user_id, name, discord_token_encrypted, discord_token_iv, discord_token_tag, suspended)
        VALUES ('system_default', ?, 'システムデフォルト', ?, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET
          discord_token_encrypted = excluded.discord_token_encrypted,
          discord_token_iv = excluded.discord_token_iv,
          discord_token_tag = excluded.discord_token_tag,
          suspended = 0,
          updated_at = datetime('now', 'localtime')
      `).run(ctx.user!.discordId, enc.encrypted, enc.iv, enc.authTag);

      addAuditLog(ctx.user!.discordId, "admin.default_bot_token");

      // 2. システムデフォルトBotの再起動
      await restartDefaultBot(token);

      sendJson(ctx.res, 200, { success: true, message: "デフォルトBotのトークンを更新しました。" });
    },
  },

  // ── システム全体の統計 ──
  {
    method: "GET",
    path: "/api/admin/stats",
    auth: "admin",
    async handler(ctx) {
      const db = getDb();
      const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
      const botCount = db.prepare("SELECT COUNT(*) as count FROM bots").get() as { count: number };
      const suspendedBotCount = db.prepare("SELECT COUNT(*) as count FROM bots WHERE suspended = 1").get() as { count: number };
      const inviteTotal = db.prepare("SELECT COUNT(*) as count FROM invite_codes").get() as { count: number };
      const inviteUsed = db.prepare("SELECT COUNT(*) as count FROM invite_codes WHERE used_by IS NOT NULL").get() as { count: number };

      sendJson(ctx.res, 200, {
        success: true,
        stats: {
          totalUsers: userCount.count,
          totalBots: botCount.count,
          suspendedBots: suspendedBotCount.count,
          totalInviteCodes: inviteTotal.count,
          usedInviteCodes: inviteUsed.count,
          availableInviteCodes: inviteTotal.count - inviteUsed.count,
        },
      });
    },
  },

  // ── システム全体設定 ──
  {
    method: "GET",
    path: "/api/admin/system-settings",
    auth: "admin",
    async handler(ctx) {
      sendJson(ctx.res, 200, {
        success: true,
        privacyPolicyUrl: getSystemSetting("privacy_policy_url") || config.privacyPolicyUrl,
        termsUrl: getSystemSetting("terms_url") || config.termsUrl,
      });
    },
  },
  {
    method: "POST",
    path: "/api/admin/system-settings",
    auth: "admin",
    async handler(ctx) {
      const privacyPolicyUrl = typeof ctx.body.privacyPolicyUrl === "string" ? ctx.body.privacyPolicyUrl.trim() : "";
      const termsUrl = typeof ctx.body.termsUrl === "string" ? ctx.body.termsUrl.trim() : "";

      // URLのバリデーション (空欄を許可。スラッシュから始まる相対パスも許可)
      for (const [label, value] of [["プライバシーポリシー", privacyPolicyUrl], ["利用規約", termsUrl]] as const) {
        if (value && !value.startsWith("/")) {
          try {
            new URL(value);
          } catch {
            return sendJson(ctx.res, 400, { success: false, message: `無効な${label}のURL形式です。` });
          }
        }
      }

      setSystemSetting("privacy_policy_url", privacyPolicyUrl);
      setSystemSetting("terms_url", termsUrl);
      sendJson(ctx.res, 200, { success: true, message: "システム設定を保存しました。" });
    },
  },

  // ── ユーザー管理 ──
  {
    method: "GET",
    path: "/api/admin/users",
    auth: "admin",
    async handler(ctx) {
      sendJson(ctx.res, 200, { success: true, users: listAllUsers() });
    },
  },
  {
    method: "POST",
    path: "/api/admin/users/role",
    auth: "admin",
    async handler(ctx) {
      const adminId = ctx.user!.discordId;
      const targetUserId = typeof ctx.body.targetUserId === "string" ? ctx.body.targetUserId : "";
      const role = ctx.body.role;

      if (!targetUserId || !role) {
        return sendJson(ctx.res, 400, { success: false, message: "targetUserId と role が必要です。" });
      }
      if (role !== "user" && role !== "admin") {
        return sendJson(ctx.res, 400, { success: false, message: "role は 'user' または 'admin' のみ指定可能です。" });
      }
      // 自己降格防止
      if (targetUserId === adminId && role === "user") {
        return sendJson(ctx.res, 400, { success: false, message: "自分自身の Admin 権限を解除することはできません。" });
      }

      const success = updateUserRole(targetUserId, role);
      if (!success) {
        return sendJson(ctx.res, 400, { success: false, message: "ロールの変更に失敗しました。ユーザーが存在しない可能性があります。" });
      }

      addAuditLog(adminId, "admin.role_change", targetUserId, role);
      // ロール変更を即時反映するためセッションを失効（再ログインさせる）
      await destroyAllSessionsForUser(targetUserId);
      sendJson(ctx.res, 200, { success: true, message: `ユーザー ${targetUserId} のロールを ${role} に変更しました。` });
    },
  },
  // ── ユーザーの強制削除（§5.3.2） ──
  {
    method: "POST",
    path: "/api/admin/users/delete",
    auth: "admin",
    async handler(ctx) {
      const adminId = ctx.user!.discordId;
      const targetUserId = typeof ctx.body.targetUserId === "string" ? ctx.body.targetUserId : "";
      if (!targetUserId) return sendJson(ctx.res, 400, { success: false, message: "targetUserId が必要です。" });
      if (targetUserId === adminId) return sendJson(ctx.res, 400, { success: false, message: "自分自身は削除できません。" });

      // 対象ユーザーがオーナーの起動中Botを停止
      for (const bot of listAllBots()) {
        if (bot.user_id === targetUserId && bot.id !== "system_default") {
          stopCustomBot(bot.id);
        }
      }

      const ok = deleteUser(targetUserId);
      if (!ok) {
        return sendJson(ctx.res, 404, { success: false, message: "ユーザーが見つかりません。" });
      }

      await destroyAllSessionsForUser(targetUserId);
      addAuditLog(adminId, "admin.user_delete", targetUserId);
      sendJson(ctx.res, 200, { success: true, message: `ユーザー ${targetUserId} を削除しました（関連データも削除されました）。` });
    },
  },

  // ── 監査ログ閲覧（§5.3.2） ──
  {
    method: "GET",
    path: "/api/admin/audit-logs",
    auth: "admin",
    async handler(ctx) {
      const action = ctx.url.searchParams.get("action") || undefined;
      const limit = Math.min(parseInt(ctx.url.searchParams.get("limit") || "200", 10), 500);
      const offset = Math.max(parseInt(ctx.url.searchParams.get("offset") || "0", 10), 0);
      sendJson(ctx.res, 200, {
        success: true,
        logs: listAuditLogs(limit, action, offset),
        total: countAuditLogs(action),
      });
    },
  },

  // ── Bot管理 ──
  {
    method: "GET",
    path: "/api/admin/bots",
    auth: "admin",
    async handler(ctx) {
      // 所有者名を取得して付与（機密情報は除外）
      const botsWithOwner = listAllBots().map((bot) => {
        const owner = getUserByDiscordId(bot.user_id);
        return {
          id: bot.id,
          name: bot.name,
          user_id: bot.user_id,
          owner_username: owner?.username || "不明",
          discord_username: bot.discord_username,
          discord_avatar_url: bot.discord_avatar_url,
          suspended: bot.suspended,
          hasCustomToken: !!bot.discord_token_encrypted,
          isRunning: customClients.has(bot.id),
          created_at: bot.created_at,
          updated_at: bot.updated_at,
        };
      });
      sendJson(ctx.res, 200, { success: true, bots: botsWithOwner });
    },
  },
  {
    method: "POST",
    path: "/api/admin/bots/suspend",
    auth: "admin",
    async handler(ctx) {
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      if (!botId) return sendJson(ctx.res, 400, { success: false, message: "botId が必要です。" });

      // 動作中のBotクライアントを停止
      stopCustomBot(botId);

      const success = suspendBot(botId);
      if (!success) {
        return sendJson(ctx.res, 400, { success: false, message: "Botの停止処分に失敗しました。" });
      }
      addAuditLog(ctx.user!.discordId, "admin.bot_suspend", botId);
      console.log(`🚫 [Admin: ${ctx.user!.discordId}] Bot ${botId} を停止処分にしました`);
      sendJson(ctx.res, 200, { success: true, message: `Bot ${botId} を停止処分にしました。Discordクライアントは停止されました。` });
    },
  },
  {
    method: "POST",
    path: "/api/admin/bots/unsuspend",
    auth: "admin",
    async handler(ctx) {
      const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
      if (!botId) return sendJson(ctx.res, 400, { success: false, message: "botId が必要です。" });

      const success = unsuspendBot(botId);
      if (!success) {
        return sendJson(ctx.res, 400, { success: false, message: "停止処分の解除に失敗しました。" });
      }
      addAuditLog(ctx.user!.discordId, "admin.bot_unsuspend", botId);
      console.log(`✅ [Admin: ${ctx.user!.discordId}] Bot ${botId} の停止処分を解除しました`);
      sendJson(ctx.res, 200, { success: true, message: `Bot ${botId} の停止処分を解除しました。所有者が再起動できるようになりました。` });
    },
  },

  // ── 招待コード ──
  {
    method: "GET",
    path: "/api/admin/invite-codes",
    auth: "admin",
    async handler(ctx) {
      sendJson(ctx.res, 200, { success: true, codes: listInviteCodes() });
    },
  },
  {
    method: "POST",
    path: "/api/admin/invite-codes",
    auth: "admin",
    async handler(ctx) {
      const code = typeof ctx.body.code === "string" ? ctx.body.code.trim() : "";
      if (!code) {
        return sendJson(ctx.res, 400, { success: false, message: "招待コードを入力してください。" });
      }
      createInviteCode(code, ctx.user!.discordId);
      addAuditLog(ctx.user!.discordId, "admin.invite_create", code);
      sendJson(ctx.res, 200, { success: true, message: `招待コード「${code}」を作成しました。` });
    },
  },
];
