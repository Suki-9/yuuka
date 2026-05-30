import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { google } from "googleapis";
import { config } from "./config.js";
import { getCachedCalendars } from "./services/googleCalendarService.js";
import { getDb } from "./db/database.js";
import {
  addTask,
  listTasks,
  completeTask,
  deleteTask,
} from "./db/taskRepo.js";
import {
  addSchedule,
  listUpcomingSchedules,
  deleteSchedule,
} from "./db/scheduleRepo.js";
import {
  addExpense,
  listRecentExpenses,
  getMonthlyTotal,
  getMonthlyCategoryBreakdown,
} from "./db/expenseRepo.js";
import { parseReceipt } from "./services/receiptParser.js";
import * as secretService from "./services/secretService.js";
import {
  createUser,
  getUserByDiscordId,
  updateUsername,
  updateGeminiSettings,
  updateGoogleSettings,
  updateBackupSettings,
  getUserGeminiConfig,
  getUserGoogleConfig,
  verifyPassword,
} from "./db/userRepo.js";
import { isValidCode, validateAndConsumeCode } from "./db/inviteRepo.js";
import { encryptText } from "./utils/crypto.js";

// セッション管理
interface SessionData {
  userId: string;
  createdAt: number;
}
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24時間
const activeSessions = new Map<string, SessionData>(); // token -> session

// ログイン試行レート制限
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15分間ロックアウト

const PUBLIC_DIR = path.resolve(process.cwd(), "src", "public");

// Mime Types 辞書
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/**
 * リクエストボディを文字列として読み込むヘルパー
 */
function getRequestBody(req: http.IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let received = 0;
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error("リクエストボディが大きすぎます"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * クッキー文字列をオブジェクトにパースするヘルパー
 */
function parseCookies(cookieHeader?: string): Record<string, string> {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;

  cookieHeader.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const name = parts[0].trim();
    const value = parts.slice(1).join("=").trim();
    if (name) {
      list[name] = decodeURIComponent(value);
    }
  });

  return list;
}

/**
 * クッキーのパースからセッションの妥当性をチェックし、ユーザーIDを返す
 */
function getSessionUser(req: http.IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies["__Host-yuuka-session"];
  if (!sessionToken) return null;

  const session = activeSessions.get(sessionToken);
  if (!session) return null;

  if (Date.now() - session.createdAt > SESSION_TTL) {
    activeSessions.delete(sessionToken);
    return null;
  }
  return session.userId;
}

/**
 * JSONレスポンスを送るショートカット
 */
function sendJson(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'self';",
  });
  res.end(JSON.stringify(data));
}

/**
 * エラーレスポンスを送るショートカット
 */
function sendError(res: http.ServerResponse, status: number, message: string) {
  sendJson(res, status, { success: false, message });
}

/**
 * セキュリティヘッダーを設定した静的ファイル配信
 */
function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = req.url === "/" || !req.url || req.url.startsWith("/?") ? "/index.html" : req.url.split("?")[0];
  
  // セキュリティ対策：パス・トラバーサルの防御
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  
  if (!resolvedPath.startsWith(PUBLIC_DIR + path.sep) && resolvedPath !== PUBLIC_DIR) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }

  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'self';",
    });

    const stream = fs.createReadStream(resolvedPath);
    stream.pipe(res);
  });
}

/**
 * Webサーバーのメインハンドラー
 */
export async function serverHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  const { method, url } = req;
  const parsedUrl = new URL(url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = parsedUrl.pathname;

  // 1. CORS対応 (ローカル接続に限定)
  res.setHeader("Access-Control-Allow-Origin", "null");

  // 2. Google OAuth コールバック (GET /api/settings/google/oauth/callback)
  if (pathname === "/api/settings/google/oauth/callback" && method === "GET") {
    const code = parsedUrl.searchParams.get("code");
    
    // コールバック時点でのセッション確認
    const userId = getSessionUser(req);
    if (!userId) {
      res.writeHead(302, { Location: "/index.html?oauth=error&msg=unauthorized" });
      res.end();
      return;
    }

    const userConfig = getUserGoogleConfig(userId);
    const clientId = userConfig?.clientId || config.googleClientId;
    const clientSecret = userConfig?.clientSecret || config.googleClientSecret;

    if (!clientId || !clientSecret) {
      res.writeHead(302, { Location: "/index.html?oauth=error&msg=missing_config" });
      res.end();
      return;
    }

    try {
      const redirectUri = config.baseUrl
        ? `${config.baseUrl.replace(/\/$/, "")}/api/settings/google/oauth/callback`
        : `${(req.headers["x-forwarded-proto"] as string) || "http"}://${req.headers.host}/api/settings/google/oauth/callback`;
      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri
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

      const refreshTokenToSave = tokens.refresh_token || userConfig?.refreshToken;
      const calendarIdToSave = userConfig?.calendarId || googleEmail || null;

      if (refreshTokenToSave) {
        updateGoogleSettings(
          userId,
          userConfig?.clientId || null,
          userConfig?.clientSecret || null,
          refreshTokenToSave,
          calendarIdToSave,
          userConfig?.calendars || []
        );
        const note = tokens.refresh_token ? "" : "&note=existing_token_used";
        res.writeHead(302, { Location: `/index.html?oauth=success${note}` });
        res.end();
      } else {
        res.writeHead(302, { Location: "/index.html?oauth=error&msg=no_refresh_token" });
        res.end();
      }
    } catch (err: any) {
      console.error("Google OAuth Callback Error:", err);
      res.writeHead(302, { Location: `/index.html?oauth=error&msg=${encodeURIComponent(err.message)}` });
      res.end();
    }
    return;
  }

  // 3. 静的ファイルのハンドリング (APIでなければすべて静的ファイルとして処理)
  if (!pathname.startsWith("/api/")) {
    serveStaticFile(req, res);
    return;
  }

  // ──────────────────────────────────────────
  // A. パブリックAPI (新規登録 / ログイン)
  // ──────────────────────────────────────────
  
  // 新規登録
  if (pathname === "/api/register" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { discordId, username, password, inviteCode } = JSON.parse(body);

      if (!discordId || !username || !password || !inviteCode) {
        return sendError(res, 400, "すべてのフィールド（Discord ID、ユーザーネーム、パスワード、招待コード）を入力してください。");
      }

      const cleanDiscordId = discordId.trim();
      const cleanUsername = username.trim();

      if (getUserByDiscordId(cleanDiscordId)) {
        return sendError(res, 400, "このDiscord IDは既に登録されています。");
      }

      if (!isValidCode(inviteCode.trim())) {
        return sendError(res, 400, "無効な、または使用済みの招待コードです。");
      }

      // ユーザー作成
      createUser(cleanDiscordId, cleanUsername, password);

      // 招待コード消費
      validateAndConsumeCode(inviteCode.trim(), cleanDiscordId);

      sendJson(res, 200, { success: true, message: "登録が完了しました！ログインしてください。" });
    } catch (err: any) {
      console.error("ユーザー登録エラー:", err);
      sendError(res, 500, "ユーザー登録に失敗しました。");
    }
    return;
  }

  // ログイン
  if (pathname === "/api/login" && method === "POST") {
    const clientIp = req.socket.remoteAddress || "unknown";

    // レート制限チェック
    const attempt = loginAttempts.get(clientIp);
    if (attempt && attempt.count >= MAX_LOGIN_ATTEMPTS && Date.now() < attempt.resetAt) {
      const remainSec = Math.ceil((attempt.resetAt - Date.now()) / 1000);
      sendError(res, 429, `ログイン試行回数が上限に達しました。${remainSec}秒後に再試行してください。`);
      return;
    }

    try {
      const body = await getRequestBody(req);
      const { discordId, password } = JSON.parse(body);

      if (!discordId || !password) {
        return sendError(res, 400, "Discord ID とパスワードを入力してください。");
      }

      const cleanDiscordId = discordId.trim();
      const user = getUserByDiscordId(cleanDiscordId);

      if (user && verifyPassword(password, user.password_hash)) {
        // ログイン成功：試行カウントをリセット
        loginAttempts.delete(clientIp);

        // セッショントークン生成
        const sessionToken = crypto.randomBytes(32).toString("hex");
        activeSessions.set(sessionToken, { userId: cleanDiscordId, createdAt: Date.now() });

        // セキュアクッキー
        res.setHeader(
          "Set-Cookie",
          `__Host-yuuka-session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );

        sendJson(res, 200, { success: true, message: "ログインに成功しました！" });
      } else {
        // ログイン失敗
        const current = loginAttempts.get(clientIp) || { count: 0, resetAt: 0 };
        current.count += 1;
        current.resetAt = Date.now() + LOGIN_LOCKOUT_MS;
        loginAttempts.set(clientIp, current);

        sendError(res, 401, "Discord ID またはパスワードが正しくありません。");
      }
    } catch (err: any) {
      sendError(res, 400, "リクエストフォーマットが不正です。");
    }
    return;
  }

  // ──────────────────────────────────────────
  // B. プライベートAPI用認証ガード
  // ──────────────────────────────────────────
  const userId = getSessionUser(req);
  if (!userId) {
    sendError(res, 401, "認証されていません。ログインし直してください。");
    return;
  }

  // ──────────────────────────────────────────
  // C. 認証済みプライベートAPI
  // ──────────────────────────────────────────
  
  // ログアウト
  if (pathname === "/api/logout" && method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies["__Host-yuuka-session"];
    if (sessionToken) {
      activeSessions.delete(sessionToken);
    }
    res.setHeader(
      "Set-Cookie",
      `__Host-yuuka-session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    );
    sendJson(res, 200, { success: true, message: "ログアウトしました。" });
    return;
  }

  // 自分自身の情報取得
  if (pathname === "/api/me" && method === "GET") {
    const user = getUserByDiscordId(userId);
    if (!user) {
      return sendError(res, 404, "ユーザーが見つかりません。");
    }
    sendJson(res, 200, {
      success: true,
      user: {
        discordId: user.discord_id,
        username: user.username,
      }
    });
    return;
  }

  // システムステータス（ユーザー個別）
  if (pathname === "/api/status" && method === "GET") {
    try {
      const db = getDb();
      
      const taskCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE user_id = ?").get(userId) as { count: number };
      const pendingTaskCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = 'pending'").get(userId) as { count: number };
      const scheduleCount = db.prepare("SELECT COUNT(*) as count FROM schedules WHERE user_id = ?").get(userId) as { count: number };
      const expenseCount = db.prepare("SELECT COUNT(*) as count FROM expenses WHERE user_id = ?").get(userId) as { count: number };

      // 優先度別の未完了タスク数
      const priorityRows = db.prepare(`
        SELECT priority, COUNT(*) as count 
        FROM tasks 
        WHERE user_id = ? AND status = 'pending' 
        GROUP BY priority
      `).all(userId) as { priority: number; count: number }[];

      const priorityMap: Record<number, number> = { 0: 0, 1: 0, 2: 0 };
      for (const row of priorityRows) {
        priorityMap[row.priority] = row.count;
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
          WHERE user_id = ? AND date = ?
        `).get(userId, dateStr) as { total: number | null };
        expenseTrend.push(sumRow && sumRow.total ? sumRow.total : 0);
      }

      const googleConfig = getUserGoogleConfig(userId);
      const geminiConfig = getUserGeminiConfig(userId);
      const user = getUserByDiscordId(userId);

      // 利用可能なカレンダー一覧をフェッチ (OAuth設定済みの場合のみ)
      const calendars = googleConfig?.clientId && googleConfig?.clientSecret && googleConfig?.refreshToken
        ? await getCachedCalendars(userId)
        : [];

      // クレデンシャルの安全なマスキング
      const mask = (str: string | null) => {
        if (!str) return "未設定";
        if (str.length <= 8) return "****";
        return str.substring(0, 4) + "..." + str.substring(str.length - 4);
      };

      sendJson(res, 200, {
        success: true,
        user: {
          discordId: userId,
          username: user?.username || userId,
        },
        stats: {
          tasks: taskCount.count,
          pendingTasks: pendingTaskCount.count,
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
          geminiModel: geminiConfig?.model || "gemini-3.1-flash-lite",
          geminiApiKey: mask(geminiConfig?.apiKeyEncrypted ? "configured" : null),
          backupEnabled: user?.google_drive_backup_enabled === 1,
          backupFolderId: mask(user?.google_drive_backup_folder_id ?? null),
          backupCron: user?.backup_cron || "0 3 * * *",
        }
      });
    } catch (err: any) {
      console.error("ステータス取得エラー:", err);
      sendError(res, 500, "ステータス取得に失敗しました。");
    }
    return;
  }

  // ── ユーザー個別設定 API ──

  // プロフィール更新
  if (pathname === "/api/settings/profile" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { username } = JSON.parse(body);
      if (!username || !username.trim()) {
        return sendError(res, 400, "有効なユーザーネームを指定してください。");
      }
      
      const success = updateUsername(userId, username.trim());
      if (success) {
        sendJson(res, 200, { success: true, message: "プロファイルを更新しました。" });
      } else {
        sendError(res, 400, "プロファイルの更新に失敗しました。同じ名前が既に使われている可能性があります。");
      }
    } catch (err: any) {
      sendError(res, 500, "プロフィール更新処理に失敗しました。");
    }
    return;
  }

  // Gemini 設定更新
  if (pathname === "/api/settings/gemini" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { apiKey, model } = JSON.parse(body);
      if (!model) return sendError(res, 400, "モデル名は必須項目です。");

      const current = getUserGeminiConfig(userId);
      let encrypted: string | null = null;
      let iv: string | null = null;
      let tag: string | null = null;

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

      updateGeminiSettings(userId, encrypted, iv, tag, model.trim());
      sendJson(res, 200, { success: true, message: "Gemini 設定を更新しました。" });
    } catch (err: any) {
      console.error("Gemini 設定更新エラー:", err);
      sendError(res, 500, "Gemini 設定の更新に失敗しました。");
    }
    return;
  }



  // Google OAuth URL 生成
  if (pathname === "/api/settings/google/oauth/url" && method === "GET") {
    const userConfig = getUserGoogleConfig(userId);
    const clientId = userConfig?.clientId || config.googleClientId;
    const clientSecret = userConfig?.clientSecret || config.googleClientSecret;

    if (!clientId || !clientSecret) {
      return sendError(res, 400, "システムに Google OAuth2 設定が登録されていません。システム管理者に問い合わせてください。");
    }

    try {
      const redirectUri = config.baseUrl
        ? `${config.baseUrl.replace(/\/$/, "")}/api/settings/google/oauth/callback`
        : `${(req.headers["x-forwarded-proto"] as string) || "http"}://${req.headers.host}/api/settings/google/oauth/callback`;
      const oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri
      );

      const scopes = [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive.file",
      ];

      const url = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: scopes,
        prompt: "consent",
      });

      sendJson(res, 200, { success: true, url });
    } catch (err: any) {
      console.error("OAuth URL 生成エラー:", err);
      sendError(res, 500, "OAuth 認証URLの生成に失敗しました。");
    }
    return;
  }

  // 利用カレンダーリスト更新
  if (pathname === "/api/settings/calendars" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { calendars } = JSON.parse(body);
      if (!Array.isArray(calendars)) {
        return sendError(res, 400, "カレンダーリストは配列形式で指定してください。");
      }

      const current = getUserGoogleConfig(userId);
      updateGoogleSettings(
        userId,
        current?.clientId || null,
        current?.clientSecret || null,
        current?.refreshToken || null,
        current?.calendarId || null,
        calendars
      );

      sendJson(res, 200, { success: true, message: "同期対象カレンダーを更新しました。" });
    } catch (err: any) {
      console.error("カレンダー設定保存エラー:", err);
      sendError(res, 500, "カレンダー同期設定の保存に失敗しました。");
    }
    return;
  }

  // バックアップ設定更新
  if (pathname === "/api/settings/backup" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { enabled, folderId, cron } = JSON.parse(body);

      updateBackupSettings(userId, enabled, folderId || null, cron || "0 3 * * *");

      const { initUserBackupSchedule } = await import("./services/backupService.js");
      initUserBackupSchedule(userId);

      sendJson(res, 200, { success: true, message: "バックアップ設定を保存しました。" });
    } catch (err: any) {
      console.error("バックアップ設定保存エラー:", err);
      sendError(res, 500, "バックアップ設定の保存に失敗しました。");
    }
    return;
  }

  // 手動バックアップトリガー
  if (pathname === "/api/settings/backup/trigger" && method === "POST") {
    try {
      const user = getUserByDiscordId(userId);
      if (!user || !user.google_drive_backup_enabled) {
        return sendError(res, 400, "バックアップ設定が無効になっています。");
      }

      const { runBackup } = await import("./services/backupService.js");
      const url = await runBackup(userId);

      sendJson(res, 200, { success: true, url, message: "手動バックアップが完了しました。" });
    } catch (err: any) {
      console.error("手動バックアップ実行エラー:", err);
      sendError(res, 500, `手動バックアップに失敗しました: ${err.message}`);
    }
    return;
  }

  // ── ユニークユーザーリスト (マルチユーザー化に伴い、互換性のために自身の情報のみを返す) ──
  if (pathname === "/api/users" && method === "GET") {
    const user = getUserByDiscordId(userId);
    const users = user ? [user.username] : ["sensei_default"];
    sendJson(res, 200, { success: true, users });
    return;
  }

  // ── 資格情報API ──
  if (pathname === "/api/credentials" && method === "GET") {
    try {
      const list = secretService.listCredentials(userId);
      sendJson(res, 200, { success: true, credentials: list });
    } catch (err: any) {
      sendError(res, 500, "資格情報一覧の取得に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/credentials/register" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { serviceName, username, password } = JSON.parse(body);

      if (!serviceName || !username || !password) {
        return sendError(res, 400, "サービス名、ユーザー名、およびパスワードは必須です。");
      }

      secretService.registerCredential(userId, serviceName, username, password);
      sendJson(res, 200, { success: true, message: "資格情報を正常に登録しました。" });
    } catch (err: any) {
      sendError(res, 500, "資格情報の登録に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/credentials/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { serviceName } = JSON.parse(body);

      if (!serviceName) {
        return sendError(res, 400, "サービス名は必須です。");
      }

      const success = secretService.deleteCredential(userId, serviceName);
      sendJson(res, 200, { success });
    } catch (err: any) {
      sendError(res, 500, "資格情報の削除に失敗しました。");
    }
    return;
  }

  // ── タスクAPI ──
  if (pathname === "/api/tasks") {
    if (method === "GET") {
      try {
        const status = parsedUrl.searchParams.get("status") || "all";
        const tasks = listTasks(userId, status);
        sendJson(res, 200, { success: true, tasks });
      } catch (err: any) {
        sendError(res, 500, "タスク一覧の取得に失敗しました。");
      }
      return;
    }
  }

  if (pathname === "/api/tasks/add" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { title, description, dueDate, priority } = JSON.parse(body);
      if (!title) return sendError(res, 400, "タイトルは必須です。");

      const task = addTask(userId, title, description, dueDate, priority);
      sendJson(res, 200, { success: true, task });
    } catch (err: any) {
      sendError(res, 500, "タスクの追加に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/tasks/complete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { id } = JSON.parse(body);
      if (!id) return sendError(res, 400, "IDが必要です。");

      const task = completeTask(id, userId);
      sendJson(res, 200, { success: true, task });
    } catch (err: any) {
      sendError(res, 500, "タスクの完了処理に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/tasks/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { id } = JSON.parse(body);
      if (!id) return sendError(res, 400, "IDが必要です。");

      const ok = deleteTask(id, userId);
      sendJson(res, 200, { success: ok });
    } catch (err: any) {
      sendError(res, 500, "タスクの削除に失敗しました。");
    }
    return;
  }

  // ── スケジュールAPI ──
  if (pathname === "/api/schedules") {
    if (method === "GET") {
      try {
        const days = parseInt(parsedUrl.searchParams.get("days") || "7", 10);
        const schedules = listUpcomingSchedules(userId, days);
        sendJson(res, 200, { success: true, schedules });
      } catch (err: any) {
        sendError(res, 500, "スケジュールの取得に失敗しました。");
      }
      return;
    }
  }

  if (pathname === "/api/schedules/add" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { title, startAt, endAt, remindBeforeMinutes, description } = JSON.parse(body);
      if (!title || !startAt) return sendError(res, 400, "タイトルと開始日時は必須です。");

      const schedule = addSchedule(
        userId,
        title,
        startAt,
        endAt,
        remindBeforeMinutes,
        description
      );
      sendJson(res, 200, { success: true, schedule });
    } catch (err: any) {
      sendError(res, 500, "スケジュールの追加に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/schedules/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { id } = JSON.parse(body);
      if (!id) return sendError(res, 400, "IDが必要です。");

      const ok = deleteSchedule(id, userId);
      sendJson(res, 200, { success: ok });
    } catch (err: any) {
      sendError(res, 500, "予定の削除に失敗しました。");
    }
    return;
  }

  // ── 家計簿API ──
  if (pathname === "/api/expenses") {
    if (method === "GET") {
      try {
        const now = new Date();
        const year = parseInt(parsedUrl.searchParams.get("year") || String(now.getFullYear()), 10);
        const month = parseInt(parsedUrl.searchParams.get("month") || String(now.getMonth() + 1), 10);
        
        const recent = listRecentExpenses(userId, 30);
        const total = getMonthlyTotal(userId, year, month);
        const breakdown = getMonthlyCategoryBreakdown(userId, year, month);

        sendJson(res, 200, {
          success: true,
          expenses: recent,
          total,
          breakdown,
        });
      } catch (err: any) {
        sendError(res, 500, "家計データの取得に失敗しました。");
      }
      return;
    }
  }

  if (pathname === "/api/expenses/add" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { amount, category, description, date } = JSON.parse(body);
      if (!amount || !category) return sendError(res, 400, "金額とカテゴリは必須です。");

      const expense = addExpense(
        userId,
        amount,
        category,
        description,
        date,
        "web"
      );
      sendJson(res, 200, { success: true, expense });
    } catch (err: any) {
      sendError(res, 500, "支出の追加に失敗しました。");
    }
    return;
  }

  // レシート解析 API
  if (pathname === "/api/expenses/upload-receipt" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { imageBase64, mimeType, additionalText } = JSON.parse(body);
      if (!imageBase64 || !mimeType) {
        return sendError(res, 400, "画像データ(base64)とMIMEタイプが必要です。");
      }

      console.log(`📸 [User: ${userId}] WEB管理画面より画像解析要求を受信 (MIME: ${mimeType})`);
      const response = await parseReceipt(userId, imageBase64, mimeType, additionalText);
      sendJson(res, 200, { success: true, response });
    } catch (err: any) {
      console.error("WEBレシート解析エラー:", err);
      sendError(res, 500, "レシート解析中にエラーが発生しました。");
    }
    return;
  }

  // 見つからないAPI
  sendError(res, 404, "APIエンドポイントが見つかりません。");
}

let server: http.Server | null = null;

/**
 * Webサーバーの起動
 */
export function startWebServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer(serverHandler);
    
    server.listen(config.port, config.host, () => {
      console.log(`🌐 Yuuka 管理画面サーバー起動完了: http://${config.host}:${config.port}`);
      
      // バックアップスケジュールの初期化
      import("./services/backupService.js").then((mod) => {
        import("./db/userRepo.js").then((userMod) => {
          const userIds = userMod.listAllUserIds();
          mod.initAllBackupSchedules(userIds);
        });
      }).catch(err => {
        console.error("バックアップスケジュールの初期化に失敗しました:", err);
      });

      resolve();
    });
  });
}

/**
 * Webサーバーの停止
 */
export function stopWebServer(): void {
  if (server) {
    server.close(() => {
      console.log("🌐 Yuuka 管理画面サーバーを停止しました。");
    });
    server = null;
  }
}
