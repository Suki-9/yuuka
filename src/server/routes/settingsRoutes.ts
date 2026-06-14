import { google } from "googleapis";
import type { RouteDef, RouteRequestCtx } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { config } from "../../config.js";
import { getDb } from "../../db/database.js";
import { setSessionCookie, getSessionToken } from "../httpHelpers.js";
import { createSession, destroySession, destroyAllSessionsForUser } from "../../services/sessionService.js";
import { validatePassword } from "../../services/passwordPolicy.js";
import {
  getUserByDiscordId,
  updateUsername,
  updatePassword,
  verifyPassword,
  isAdmin,
  getUserGeminiConfig,
  updateUserGeminiSettings,
  getUserGoogleConfig,
  updateUserGoogleSettings,
  getUserBackupConfig,
  updateUserBackupSettings,
  updateUserSettings,
  getUserRichReplyEnabled,
  getUserRemindDefaultMinutes,
  getUserNotifyTarget,
  getActivePersonaId,
} from "../../db/userRepo.js";
import { addAuditLog } from "../../db/auditRepo.js";
import {
  getBotById,
  getBotDiscordConfig,
  updateBotDiscordToken,
  hasBotAccess,
  isBotSuspended,
} from "../../db/botRepo.js";
import { startCustomBot, stopCustomBot, restartDefaultBot } from "../../bot.js";
import { encryptText, decryptText } from "../../utils/crypto.js";
import { getCachedCalendars, invalidateCalendarCache } from "../../services/googleCalendarService.js";
import { extractDriveFolderId } from "../../services/googleDriveService.js";

// ─── ユーザー設定・ステータス HTTPルート ─────────────────────────────────────

/** OAuthリダイレクトURIの構築（baseUrl 未設定時はリクエストヘッダから推定） */
function buildOAuthRedirectUri(ctx: RouteRequestCtx): string {
  return config.baseUrl
    ? `${config.baseUrl.replace(/\/$/, "")}/api/settings/google/oauth/callback`
    : `${(ctx.req.headers["x-forwarded-proto"] as string) || "http"}://${ctx.req.headers.host}/api/settings/google/oauth/callback`;
}

/** クレデンシャルの安全なマスキング */
function mask(str: string | null): string {
  if (!str) return "未設定";
  if (str.length <= 8) return "****";
  return str.substring(0, 4) + "..." + str.substring(str.length - 4);
}

export const settingsRoutes: RouteDef[] = [
  // ── システムステータス（ユーザー個別のダッシュボード用集計） ──
  {
    method: "GET",
    path: "/api/status",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const db = getDb();

      // v2: ユーザースコープの統計（読み取り専用の集計クエリ）
      const todoCount = db.prepare("SELECT COUNT(*) as count FROM todos WHERE user_id = ?").get(userId) as { count: number };
      const openTodoCount = db.prepare("SELECT COUNT(*) as count FROM todos WHERE user_id = ? AND status = 'open'").get(userId) as { count: number };
      const scheduleCount = db.prepare("SELECT COUNT(*) as count FROM schedules WHERE user_id = ?").get(userId) as { count: number };
      const expenseCount = db.prepare("SELECT COUNT(*) as count FROM expenses WHERE user_id = ?").get(userId) as { count: number };

      // 優先度別の未完了ToDo数（v2: high/medium/low。旧UI互換のため 2/1/0 キーでも返す）
      const priorityRows = db.prepare(`
        SELECT priority, COUNT(*) as count
        FROM todos
        WHERE user_id = ? AND status = 'open'
        GROUP BY priority
      `).all(userId) as { priority: string | null; count: number }[];

      const priorityMap: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
      for (const row of priorityRows) {
        if (row.priority === "high") priorityMap[2] += row.count;
        else if (row.priority === "medium") priorityMap[1] += row.count;
        else priorityMap[0] += row.count;
      }

      // スケジュールの直近5日間のイベント数推移 (今日から4日後まで)
      const scheduleTrend: number[] = [];
      for (let i = 0; i < 5; i++) {
        const dateStr = new Date(Date.now() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const countRow = db.prepare(`
          SELECT COUNT(*) as count
          FROM schedules
          WHERE user_id = ? AND date(start_at) = date(?)
        `).get(userId, dateStr) as { count: number };
        scheduleTrend.push(countRow ? countRow.count : 0);
      }

      // 経費の過去5日間の支出額推移 (4日前から今日まで)
      const expenseTrend: number[] = [];
      for (let i = 4; i >= 0; i--) {
        const dateStr = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const sumRow = db.prepare(`
          SELECT SUM(amount) as total
          FROM expenses
          WHERE user_id = ? AND type = 'expense' AND date = ?
        `).get(userId, dateStr) as { total: number | null };
        expenseTrend.push(sumRow && sumRow.total ? sumRow.total : 0);
      }

      const googleConfig = getUserGoogleConfig(userId);
      const geminiConfig = getUserGeminiConfig(userId);
      const backupConfig = getUserBackupConfig(userId);
      const googleLinked = !!googleConfig?.refreshTokenEncrypted;

      // 利用可能なカレンダー一覧をフェッチ (OAuth設定済みの場合のみ)
      const calendars = googleLinked ? await getCachedCalendars(userId) : [];

      sendJson(ctx.res, 200, {
        success: true,
        user: {
          discordId: userId,
          username: getUserByDiscordId(userId)?.username || userId,
        },
        stats: {
          tasks: todoCount.count,
          pendingTasks: openTodoCount.count,
          pendingPriorities: priorityMap,
          schedules: scheduleCount.count,
          scheduleTrend,
          expenses: expenseCount.count,
          expenseTrend,
        },
        config: {
          dbPath: config.dbPath,
          reminderCron: config.reminderCron,
          googleCalendarId: googleConfig?.calendarId || "未設定",
          googleCalendars: calendars,
          googleLinked,
          geminiModel: geminiConfig?.model || "gemini-3.1-flash-lite",
          geminiApiKey: mask(geminiConfig?.apiKeyEncrypted ? "configured" : null),
          backupEnabled: backupConfig?.enabled === true,
          backupFolderId: mask(backupConfig?.folderId ?? null),
          backupIntervalHours: backupConfig?.intervalHours ?? 24,
          backupGenerations: backupConfig?.generations ?? 7,
          backupLastRunAt: backupConfig?.lastRunAt ?? null,
          richReplyEnabled: getUserRichReplyEnabled(userId),
          remindDefaultMinutes: getUserRemindDefaultMinutes(userId),
          notifyTarget: getUserNotifyTarget(userId),
          activePersonaId: getActivePersonaId(userId),
        },
      });
    },
  },

  // ── プロフィール更新 ──
  {
    method: "POST",
    path: "/api/settings/profile",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const username = typeof ctx.body.username === "string" ? ctx.body.username.trim() : "";
      if (!username) {
        return sendJson(ctx.res, 400, { success: false, message: "有効なユーザーネームを指定してください。" });
      }

      const success = updateUsername(userId, username);
      if (!success) {
        return sendJson(ctx.res, 400, {
          success: false,
          message: "プロファイルの更新に失敗しました。同じ名前が既に使われている可能性があります。",
        });
      }

      // セッション内のユーザー名を更新するため再発行
      const token = getSessionToken(ctx.req);
      if (token) await destroySession(token);
      const newToken = await createSession({ discordId: userId, username, role: ctx.user!.role });
      setSessionCookie(ctx.res, ctx.req, newToken);
      sendJson(ctx.res, 200, { success: true, message: "プロファイルを更新しました。" });
    },
  },

  // ── パスワード変更（§5.4.2: 変更時に全セッション即時失効） ──
  {
    method: "POST",
    path: "/api/settings/password",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const { currentPassword, newPassword } = ctx.body as Record<string, string>;
      if (!currentPassword || !newPassword) {
        return sendJson(ctx.res, 400, { success: false, message: "現在のパスワードと新しいパスワードを入力してください。" });
      }

      const user = getUserByDiscordId(userId);
      if (!user || !verifyPassword(currentPassword, user.password_hash)) {
        return sendJson(ctx.res, 401, { success: false, message: "現在のパスワードが正しくありません。" });
      }

      const policy = validatePassword(newPassword);
      if (!policy.ok) {
        return sendJson(ctx.res, 400, { success: false, message: policy.reason || "新しいパスワードがポリシーを満たしていません。" });
      }

      updatePassword(userId, newPassword);
      await destroyAllSessionsForUser(userId);
      addAuditLog(userId, "auth.password_change");

      // 新しいセッションを発行して継続ログイン
      const newToken = await createSession({ discordId: userId, username: user.username, role: ctx.user!.role });
      setSessionCookie(ctx.res, ctx.req, newToken);
      sendJson(ctx.res, 200, { success: true, message: "パスワードを変更しました。他の端末のセッションは無効化されました。" });
    },
  },

  // ── ユーザー設定更新（リッチ返信・リマインド既定・通知先 §3.0.5, §3.3.2） ──
  {
    method: "POST",
    path: "/api/settings/user",
    auth: "user",
    async handler(ctx) {
      const { richReplyEnabled, remindDefaultMinutes, notifyTargetType, notifyTargetId, timezone } = ctx.body as Record<string, unknown>;

      updateUserSettings(ctx.user!.discordId, {
        ...(richReplyEnabled !== undefined ? { richReplyEnabled: richReplyEnabled === true } : {}),
        ...(remindDefaultMinutes !== undefined ? { remindDefaultMinutes: Math.max(0, Number(remindDefaultMinutes) || 0) } : {}),
        ...(notifyTargetType !== undefined ? { notifyTargetType: notifyTargetType === "channel" ? ("channel" as const) : ("dm" as const) } : {}),
        ...(notifyTargetId !== undefined
          ? { notifyTargetId: typeof notifyTargetId === "string" && notifyTargetId.trim() ? notifyTargetId.trim() : null }
          : {}),
        ...(typeof timezone === "string" && timezone.trim() ? { timezone: timezone.trim() } : {}),
      });

      sendJson(ctx.res, 200, { success: true, message: "ユーザー設定を更新しました。" });
    },
  },

  // ── Gemini 設定更新（v2: ユーザー単位のみ §4.2） ──
  {
    method: "POST",
    path: "/api/settings/gemini",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const { apiKey, model } = ctx.body as Record<string, string>;
      if (!model) return sendJson(ctx.res, 400, { success: false, message: "モデル名は必須項目です。" });

      const current = getUserGeminiConfig(userId);
      let encrypted: string | null;
      let iv: string | null;
      let tag: string | null;

      if (apiKey && !apiKey.startsWith("****")) {
        const enc = encryptText(apiKey.trim());
        encrypted = enc.encrypted;
        iv = enc.iv;
        tag = enc.authTag;
      } else {
        encrypted = current?.apiKeyEncrypted ?? null;
        iv = current?.apiKeyIv ?? null;
        tag = current?.apiKeyTag ?? null;
      }

      updateUserGeminiSettings(userId, encrypted, iv, tag, model.trim());
      sendJson(ctx.res, 200, { success: true, message: "Gemini 設定を更新しました。" });
    },
  },

  // ── Discord 独自Botトークン設定（§4.3.1: トークンはBotオーナーのみ） ──
  {
    method: "GET",
    path: "/api/settings/discord",
    auth: "user",
    async handler(ctx) {
      const botId = ctx.url.searchParams.get("botId") || "system_default";
      if (!hasBotAccess(ctx.user!.discordId, botId)) {
        return sendJson(ctx.res, 403, { success: false, message: "アクセス権限がありません。" });
      }
      const current = getBotDiscordConfig(botId);
      const hasToken = !!(current?.tokenEncrypted && current?.tokenIv && current?.tokenTag);
      sendJson(ctx.res, 200, { success: true, hasToken, tokenMasked: hasToken ? "••••••••••••" : "" });
    },
  },
  {
    method: "POST",
    path: "/api/settings/discord",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const botId = typeof ctx.body.botId === "string" && ctx.body.botId ? ctx.body.botId : "system_default";
      const token = typeof ctx.body.token === "string" ? ctx.body.token : "";

      if (botId === "system_default") {
        if (!isAdmin(userId)) {
          return sendJson(ctx.res, 403, { success: false, message: "システムBotのDiscord設定は管理者のみ変更可能です。" });
        }
      } else {
        const bot = getBotById(botId);
        if (!bot || bot.user_id !== userId) {
          return sendJson(ctx.res, 403, { success: false, message: "Botのトークンはオーナーのみが変更できます。" });
        }
      }

      const current = getBotDiscordConfig(botId);
      let encrypted: string | null = null;
      let iv: string | null = null;
      let tag: string | null = null;
      let tokenChanged = false;
      let tokenCleared = false;

      // トークンの処理
      if (!token.trim()) {
        // 空欄の場合はクリア（削除）
        if (current?.tokenEncrypted) {
          tokenChanged = true;
          tokenCleared = true;
        }
      } else if (token.startsWith("••••")) {
        // マスクの場合は変更なし
        encrypted = current?.tokenEncrypted ?? null;
        iv = current?.tokenIv ?? null;
        tag = current?.tokenTag ?? null;
      } else {
        // 新しいトークンが入力された
        const enc = encryptText(token.trim());
        encrypted = enc.encrypted;
        iv = enc.iv;
        tag = enc.authTag;
        tokenChanged = true;
      }

      updateBotDiscordToken(botId, encrypted, iv, tag);
      addAuditLog(userId, "bot.token_change", botId, tokenCleared ? "cleared" : tokenChanged ? "updated" : "unchanged");

      // トークンがクリアされた場合、動作中の独自Botを完全にクローズする
      if (tokenCleared) {
        stopCustomBot(botId);
      }

      // トークンが変更された場合、新しいBotを非同期でログイン・動的起動する
      let botStartupMessage = "";
      if (tokenChanged && encrypted !== null) {
        if (isBotSuspended(botId)) {
          botStartupMessage = " このBotは管理者により停止処分中のため、起動できません。";
        } else if (botId === "system_default") {
          // デフォルトBotは専用の再起動フロー
          const plainToken = decryptText(encrypted, iv!, tag!);
          const ok = await restartDefaultBot(plainToken);
          if (!ok) botStartupMessage = " 設定は保存されましたが、デフォルトBotの起動に失敗しました。";
        } else {
          console.log(`[Discord Bot] Bot ${botId} の独自Botの再起動を試みます...`);
          const startupSuccess = await startCustomBot(botId);
          if (!startupSuccess) {
            botStartupMessage = " 設定は保存されましたが、独自Botの起動に失敗しました。トークンが有効か再度ご確認ください。";
          }
        }
      }

      sendJson(ctx.res, 200, { success: true, message: `設定を保存しました。${botStartupMessage}`.trim() });
    },
  },

  // ── Google OAuth URL 生成（v2: ユーザー単位連携） ──
  {
    method: "GET",
    path: "/api/settings/google/oauth/url",
    auth: "user",
    async handler(ctx) {
      if (!config.googleClientId || !config.googleClientSecret) {
        return sendJson(ctx.res, 400, {
          success: false,
          message: "システムに Google OAuth2 設定が登録されていません。システム管理者に問い合わせてください。",
        });
      }

      const oauth2Client = new google.auth.OAuth2(
        config.googleClientId,
        config.googleClientSecret,
        buildOAuthRedirectUri(ctx)
      );

      const scopes = [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive.file",
      ];

      const oauthUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: scopes,
        prompt: "consent",
        state: "user-link", // 連携対象はセッションユーザー（コールバックで検証）
      });

      sendJson(ctx.res, 200, { success: true, url: oauthUrl });
    },
  },

  // ── Google OAuth コールバック（リダイレクト応答のため auth:"none" + 手動セッション検証） ──
  {
    method: "GET",
    path: "/api/settings/google/oauth/callback",
    auth: "none",
    async handler(ctx) {
      const redirect = (location: string) => {
        ctx.res.writeHead(302, { Location: location });
        ctx.res.end();
      };

      // コールバック時点でのセッション確認
      if (!ctx.user) {
        return redirect("/?oauth=error&msg=unauthorized");
      }
      const userId = ctx.user.discordId;

      if (!config.googleClientId || !config.googleClientSecret) {
        return redirect("/?oauth=error&msg=missing_config");
      }

      try {
        const code = ctx.url.searchParams.get("code");
        const oauth2Client = new google.auth.OAuth2(
          config.googleClientId,
          config.googleClientSecret,
          buildOAuthRedirectUri(ctx)
        );

        const { tokens } = await oauth2Client.getToken(code!);
        oauth2Client.setCredentials(tokens);

        let googleEmail: string | null = null;
        try {
          const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
          const userInfo = await oauth2.userinfo.get();
          googleEmail = userInfo.data.email || null;
        } catch (e) {
          console.warn("Failed to fetch user email during settings link:", e);
        }

        const currentConfig = getUserGoogleConfig(userId);
        if (tokens.refresh_token) {
          const enc = encryptText(tokens.refresh_token);
          updateUserGoogleSettings(userId, {
            refreshTokenEncrypted: enc.encrypted,
            refreshTokenIv: enc.iv,
            refreshTokenTag: enc.authTag,
            calendarId: currentConfig?.calendarId || googleEmail || null,
          });
          invalidateCalendarCache(userId);
          addAuditLog(userId, "auth.google_link", googleEmail ?? undefined);
          redirect("/?oauth=success");
        } else if (currentConfig?.refreshTokenEncrypted) {
          // 既存トークンを継続利用
          redirect("/?oauth=success&note=existing_token_used");
        } else {
          redirect("/?oauth=error&msg=no_refresh_token");
        }
      } catch (err) {
        console.error("Google OAuth Callback Error:", err);
        redirect(`/?oauth=error&msg=${encodeURIComponent((err as Error).message)}`);
      }
    },
  },

  // ── 利用カレンダーリスト更新（v2: ユーザー単位） ──
  {
    method: "POST",
    path: "/api/settings/calendars",
    auth: "user",
    async handler(ctx) {
      const { calendars } = ctx.body as { calendars?: unknown };
      if (!Array.isArray(calendars)) {
        return sendJson(ctx.res, 400, { success: false, message: "カレンダーリストは配列形式で指定してください。" });
      }
      updateUserGoogleSettings(ctx.user!.discordId, { calendars: calendars.map(String) });
      invalidateCalendarCache(ctx.user!.discordId);
      sendJson(ctx.res, 200, { success: true, message: "同期対象カレンダーを更新しました。" });
    },
  },

  // ── バックアップ設定（v2: ユーザー単位・間隔/世代数 §8.2） ──
  {
    method: "POST",
    path: "/api/settings/backup",
    auth: "user",
    async handler(ctx) {
      const { enabled, folderId, intervalHours, generations } = ctx.body as Record<string, unknown>;

      // フォルダ指定はフォルダID単体・Google DriveのフォルダURLのどちらも受け付ける
      let normalizedFolderId: string | undefined = undefined;
      if (typeof folderId === "string" && folderId.trim()) {
        const extracted = extractDriveFolderId(folderId);
        if (!extracted) {
          sendJson(ctx.res, 400, {
            success: false,
            message: "バックアップ先フォルダの指定が不正です。フォルダIDまたはGoogle DriveのフォルダURLを入力してください。",
          });
          return;
        }
        normalizedFolderId = extracted;
      }

      updateUserBackupSettings(ctx.user!.discordId, {
        enabled: enabled === true,
        intervalHours: Number(intervalHours) || 24,
        generations: Number(generations) || 7,
        folderId: normalizedFolderId,
      });
      sendJson(ctx.res, 200, { success: true, message: "バックアップ設定を保存しました。" });
    },
  },
  {
    method: "POST",
    path: "/api/settings/backup/trigger",
    auth: "user",
    async handler(ctx) {
      try {
        const { runBackup } = await import("../../services/backupService.js");
        const backupUrl = await runBackup(ctx.user!.discordId);
        addAuditLog(ctx.user!.discordId, "backup.manual_run");
        sendJson(ctx.res, 200, { success: true, url: backupUrl, message: "手動バックアップが完了しました。" });
      } catch (err) {
        console.error("手動バックアップ実行エラー:", err);
        sendJson(ctx.res, 500, { success: false, message: `手動バックアップに失敗しました: ${(err as Error).message}` });
      }
    },
  },
];
