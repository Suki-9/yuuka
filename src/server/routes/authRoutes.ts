import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { config } from "../../config.js";
import { setSessionCookie, getSessionToken } from "../httpHelpers.js";
import { createSession, destroySession } from "../../services/sessionService.js";
import { validatePassword } from "../../services/passwordPolicy.js";
import {
  createUser,
  getUserByDiscordId,
  verifyPassword,
  listAllUsers,
} from "../../db/userRepo.js";
import { isValidCode, validateAndConsumeCode } from "../../db/inviteRepo.js";
import { encryptText } from "../../utils/crypto.js";
import { updateUserGeminiSettings } from "../../db/userRepo.js";
import { addAuditLog } from "../../db/auditRepo.js";
import { getSystemSetting } from "../../db/systemSettingsRepo.js";

// ─── 認証・登録 HTTPルート（§5.4） ───────────────────────────────────────────

// ログイン試行レート制限（IP単位）
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15分間ロックアウト

function publicLegalUrls(): { privacyPolicyUrl: string; termsUrl: string } {
  return {
    privacyPolicyUrl: getSystemSetting("privacy_policy_url") || config.privacyPolicyUrl,
    termsUrl: getSystemSetting("terms_url") || config.termsUrl,
  };
}

export const authRoutes: RouteDef[] = [
  // ── セットアップ状態の確認 ──
  {
    method: "GET",
    path: "/api/setup/status",
    auth: "none",
    async handler(ctx) {
      const users = listAllUsers();
      sendJson(ctx.res, 200, { needSetup: users.length === 0, ...publicLegalUrls() });
    },
  },

  // ── 初期セットアップ実行（最初のユーザー＝管理者登録） ──
  {
    method: "POST",
    path: "/api/setup",
    auth: "none",
    async handler(ctx) {
      const users = listAllUsers();
      if (users.length > 0) {
        return sendJson(ctx.res, 400, { success: false, message: "システムは既にセットアップされています。" });
      }

      const { discordId, username, password, geminiApiKey } = ctx.body as Record<string, string>;
      if (!discordId || !username || !password || !geminiApiKey) {
        return sendJson(ctx.res, 400, {
          success: false,
          message: "すべてのフィールド（Discord ID、ユーザーネーム、パスワード、Gemini API Key）を入力してください。",
        });
      }

      // パスワードポリシー検証（§5.4.3）
      const policy = validatePassword(password);
      if (!policy.ok) {
        return sendJson(ctx.res, 400, { success: false, message: policy.reason || "パスワードがポリシーを満たしていません。" });
      }

      const cleanDiscordId = discordId.trim();
      const cleanUsername = username.trim();

      // 1. 管理者ユーザーの登録 (最初の登録なので自動的に admin ロールになる)
      const user = createUser(cleanDiscordId, cleanUsername, password);

      // 2. Gemini APIキーの登録（暗号化保存 §4.2）
      const enc = encryptText(geminiApiKey.trim());
      updateUserGeminiSettings(cleanDiscordId, enc.encrypted, enc.iv, enc.authTag, "gemini-3.1-flash-lite");

      // 3. セッショントークン生成と自動ログイン
      const sessionToken = await createSession({
        discordId: user.discord_id,
        username: user.username,
        role: user.role as "user" | "admin",
      });
      addAuditLog(cleanDiscordId, "auth.register", "initial_setup");

      setSessionCookie(ctx.res, ctx.req, sessionToken);
      sendJson(ctx.res, 200, { success: true, message: "管理者登録が完了しました。続いてデフォルトBotを設定してください。" });
    },
  },

  // ── 新規登録（招待コード必須） ──
  {
    method: "POST",
    path: "/api/register",
    auth: "none",
    async handler(ctx) {
      const { discordId, username, password, inviteCode, geminiApiKey } = ctx.body as Record<string, string>;
      if (!discordId || !username || !password || !inviteCode || !geminiApiKey) {
        return sendJson(ctx.res, 400, {
          success: false,
          message: "すべてのフィールド（Discord ID、ユーザーネーム、パスワード、招待コード、Gemini API Key）を入力してください。",
        });
      }

      const cleanDiscordId = discordId.trim();
      const cleanUsername = username.trim();

      if (getUserByDiscordId(cleanDiscordId)) {
        return sendJson(ctx.res, 400, { success: false, message: "このDiscord IDは既に登録されています。" });
      }
      if (!isValidCode(inviteCode.trim())) {
        return sendJson(ctx.res, 400, { success: false, message: "無効な、または使用済みの招待コードです。" });
      }

      // パスワードポリシー検証（§5.4.3）
      const policy = validatePassword(password);
      if (!policy.ok) {
        return sendJson(ctx.res, 400, { success: false, message: policy.reason || "パスワードがポリシーを満たしていません。" });
      }

      // ユーザー作成（salt自動生成 §6.2）
      createUser(cleanDiscordId, cleanUsername, password);

      // Gemini APIキーの登録（暗号化保存 §4.2）
      const enc = encryptText(geminiApiKey.trim());
      updateUserGeminiSettings(cleanDiscordId, enc.encrypted, enc.iv, enc.authTag, "gemini-3.1-flash-lite");

      // 招待コード消費
      validateAndConsumeCode(inviteCode.trim(), cleanDiscordId);
      addAuditLog(cleanDiscordId, "auth.register");

      sendJson(ctx.res, 200, { success: true, message: "登録が完了しました！ログインしてください。" });
    },
  },

  // ── ログイン ──
  {
    method: "POST",
    path: "/api/login",
    auth: "none",
    async handler(ctx) {
      const clientIp = ctx.req.socket.remoteAddress || "unknown";

      // レート制限チェック
      const attempt = loginAttempts.get(clientIp);
      if (attempt && attempt.count >= MAX_LOGIN_ATTEMPTS && Date.now() < attempt.resetAt) {
        const remainSec = Math.ceil((attempt.resetAt - Date.now()) / 1000);
        return sendJson(ctx.res, 429, {
          success: false,
          message: `ログイン試行回数が上限に達しました。${remainSec}秒後に再試行してください。`,
        });
      }

      const { discordId, password } = ctx.body as Record<string, string>;
      if (!discordId || !password) {
        return sendJson(ctx.res, 400, { success: false, message: "Discord ID とパスワードを入力してください。" });
      }

      const cleanDiscordId = discordId.trim();
      const user = getUserByDiscordId(cleanDiscordId);

      if (user && verifyPassword(password, user.password_hash)) {
        // ログイン成功：試行カウントをリセット
        loginAttempts.delete(clientIp);

        // Redisセッション発行（7日スライディングウィンドウ §5.4.2）
        const sessionToken = await createSession({
          discordId: user.discord_id,
          username: user.username,
          role: (user.role as "user" | "admin") || "user",
        });
        addAuditLog(cleanDiscordId, "auth.login");

        setSessionCookie(ctx.res, ctx.req, sessionToken);
        sendJson(ctx.res, 200, { success: true, message: "ログインに成功しました！" });
      } else {
        // ログイン失敗
        const current = loginAttempts.get(clientIp) || { count: 0, resetAt: 0 };
        current.count += 1;
        current.resetAt = Date.now() + LOGIN_LOCKOUT_MS;
        loginAttempts.set(clientIp, current);

        if (user) {
          addAuditLog(cleanDiscordId, "auth.login_failed");
        }
        sendJson(ctx.res, 401, { success: false, message: "Discord ID またはパスワードが正しくありません。" });
      }
    },
  },

  // ── ログアウト ──
  {
    method: "POST",
    path: "/api/logout",
    auth: "user",
    async handler(ctx) {
      const token = getSessionToken(ctx.req);
      if (token) {
        await destroySession(token);
      }
      setSessionCookie(ctx.res, ctx.req, "", 0);
      sendJson(ctx.res, 200, { success: true, message: "ログアウトしました。" });
    },
  },

  // ── 自分自身の情報取得 ──
  {
    method: "GET",
    path: "/api/me",
    auth: "user",
    async handler(ctx) {
      const user = getUserByDiscordId(ctx.user!.discordId);
      if (!user) {
        return sendJson(ctx.res, 404, { success: false, message: "ユーザーが見つかりません。" });
      }
      sendJson(ctx.res, 200, {
        success: true,
        user: {
          discordId: user.discord_id,
          username: user.username,
          role: user.role || "user",
        },
        ...publicLegalUrls(),
      });
    },
  },

  // ── ユニークユーザーリスト (互換性のために自身の情報のみを返す) ──
  {
    method: "GET",
    path: "/api/users",
    auth: "user",
    async handler(ctx) {
      const user = getUserByDiscordId(ctx.user!.discordId);
      sendJson(ctx.res, 200, { success: true, users: user ? [user.username] : [] });
    },
  },
];
