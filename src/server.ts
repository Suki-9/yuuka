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
  getBudgetLimits,
  upsertBudgetLimit,
  deleteBudgetLimit,
  addExpensePlan,
  listExpensePlans,
  markExpensePlanPaid,
  deleteExpensePlan,
} from "./db/expenseRepo.js";
import { parseReceipt } from "./services/receiptParser.js";
import * as secretService from "./services/secretService.js";
import {
  createUser,
  getUserByDiscordId,
  updateUsername,
  verifyPassword,
  listAllUsers,
  updateUserRole,
  isAdmin,
  getUserGeminiConfig,
  updateUserGeminiSettings,
} from "./db/userRepo.js";
import {
  createBot,
  getBotById,
  listBotsForUser,
  deleteBot,
  updateBotSettings,
  updateBotGeminiSettings,
  updateBotGoogleSettings,
  updateBotBackupSettings,
  getBotGeminiConfig,
  getBotGoogleConfig,
  getBotDiscordConfig,
  updateBotDiscordProfile,
  updateBotProfile,
  listAllBots,
  suspendBot,
  unsuspendBot,
  isBotSuspended,
} from "./db/botRepo.js";
import { startCustomBot, stopCustomBot, client as defaultBotClient, customClients, restartDefaultBot } from "./bot.js";
import { isValidCode, validateAndConsumeCode, listInviteCodes, createInviteCode } from "./db/inviteRepo.js";
import { encryptText } from "./utils/crypto.js";
import { findPlaybooks, savePlaybook, deletePlaybook } from "./services/playbookService.js";


/**
 * セッションユーザーが指定された Bot ID にアクセス可能（所有者、または共有権限あり）かチェックする
 */
function verifyBotAccess(userId: string, botId: string | null): boolean {
  if (!botId) return false;
  if (botId === "system_default") return true; // デフォルトBotには全員アクセス可能
  
  // 1. 所有者であるかチェック
  const bot = getBotById(botId);
  if (bot && bot.user_id === userId) return true;
  
  // 2. 共有権限があるかチェック
  const db = getDb();
  const row = db.prepare("SELECT 1 FROM user_bot_access WHERE user_id = ? AND bot_id = ? LIMIT 1").get(userId, botId);
  return !!row;
}

/**
 * セッションユーザーが Admin ロールかどうかチェックする
 */
function verifyAdmin(userId: string): boolean {
  return isAdmin(userId);
}

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

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'self';";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Content-Security-Policy": CSP,
} as const;

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
      try {
        // 旧フロントエンド互換性：JSONボディに botId がない場合、デフォルトBot IDを補完する
        if (body.trim().startsWith("{")) {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === "object" && (!parsed.botId || parsed.botId.trim() === "")) {
            parsed.botId = "system_default";
            resolve(JSON.stringify(parsed));
            return;
          }
        }
      } catch (e) {
        // パースエラー時はそのまま
      }
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
 * セッションクッキーをレスポンスにセットする
 * maxAge=0 を指定するとクッキーを削除（ログアウト）する
 */
function setSessionCookie(res: http.ServerResponse, req: http.IncomingMessage, token: string, maxAge?: number): void {
  const isHttps = checkHttps(req);
  const name = isHttps ? "__Host-yuuka-session" : "yuuka-session";
  const secure = isHttps ? "; Secure" : "";
  const expires = maxAge !== undefined ? `; Max-Age=${maxAge}` : "";
  res.setHeader("Set-Cookie", `${name}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax${expires}`);
}

/**
 * リクエストが HTTPS 経由であるかどうかを判別する
 */
function checkHttps(req: http.IncomingMessage): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isForwardedHttps = typeof forwardedProto === "string" && forwardedProto.toLowerCase() === "https";
  const isEncrypted = !!(req.socket as any).encrypted;

  return isForwardedHttps || isEncrypted;
}

/**
 * クッキーのパースからセッションの妥当性をチェックし、ユーザーIDを返す
 */
function getSessionUser(req: http.IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie);
  
  // 1. セキュアクッキーを優先して検証
  const hostToken = cookies["__Host-yuuka-session"];
  if (hostToken) {
    const session = activeSessions.get(hostToken);
    if (session && Date.now() - session.createdAt <= SESSION_TTL) {
      return session.userId;
    }
  }

  // 2. フォールバックとして通常のセッションクッキーを検証
  const standardToken = cookies["yuuka-session"];
  if (standardToken) {
    const session = activeSessions.get(standardToken);
    if (session && Date.now() - session.createdAt <= SESSION_TTL) {
      return session.userId;
    }
  }

  return null;
}

/**
 * JSONレスポンスを送るショートカット
 */
function sendJson(res: http.ServerResponse, status: number, data: any) {
  res.writeHead(status, { "Content-Type": "application/json", ...SECURITY_HEADERS });
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
    let finalPath = resolvedPath;
    if (err || !stats.isFile()) {
      const ext = path.extname(resolvedPath);
      // SPAのパスルーティング（拡張子なしのパス）の場合は、index.htmlを配信する
      if (!ext) {
        finalPath = path.join(PUBLIC_DIR, "index.html");
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 Not Found");
        return;
      }
    }

    const ext = path.extname(finalPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      ...SECURITY_HEADERS,
    });

    const stream = fs.createReadStream(finalPath);
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

  // HTTPからHTTPSへのリダイレクト判定
  if (config.baseUrl && config.baseUrl.toLowerCase().startsWith("https://")) {
    const isHttps = checkHttps(req);
    if (!isHttps) {
      const baseUrlObj = new URL(config.baseUrl);
      const reqHost = req.headers.host;
      if (reqHost) {
        const reqHostName = reqHost.split(":")[0];
        if (reqHostName === baseUrlObj.hostname) {
          // HTTPSのURLに301リダイレクト
          res.writeHead(301, { Location: `https://${baseUrlObj.hostname}${url || ""}` });
          res.end();
          return;
        }
      }
    }
  }

  // 1. CORS対応 (ローカル接続または信頼されたオリジンに限定)
  const requestOrigin = req.headers.origin;
  if (requestOrigin) {
    let isAllowedOrigin = false;
    if (requestOrigin.startsWith("http://localhost:") || requestOrigin.startsWith("http://127.0.0.1:")) {
      isAllowedOrigin = true;
    } else if (config.baseUrl) {
      try {
        const baseUrlObj = new URL(config.baseUrl);
        const originUrlObj = new URL(requestOrigin);
        if (originUrlObj.hostname === baseUrlObj.hostname) {
          isAllowedOrigin = true;
        }
      } catch {}
    }

    if (isAllowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }

  // 2. Google OAuth コールバック (GET /api/settings/google/oauth/callback)
  if (pathname === "/api/settings/google/oauth/callback" && method === "GET") {
    const code = parsedUrl.searchParams.get("code");
    const state = parsedUrl.searchParams.get("state"); // botId が入っている
    
    // コールバック時点でのセッション確認
    const userId = getSessionUser(req);
    if (!userId) {
      res.writeHead(302, { Location: "/?oauth=error&msg=unauthorized" });
      res.end();
      return;
    }

    const botId = state;
    if (!verifyBotAccess(userId, botId)) {
      res.writeHead(302, { Location: "/?oauth=error&msg=unauthorized" });
      res.end();
      return;
    }

    const userConfig = getBotGoogleConfig(botId!);
    const clientId = userConfig?.clientId || config.googleClientId;
    const clientSecret = userConfig?.clientSecret || config.googleClientSecret;

    if (!clientId || !clientSecret) {
      res.writeHead(302, { Location: "/?oauth=error&msg=missing_config" });
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
        updateBotGoogleSettings(
          botId!,
          userConfig?.clientId || null,
          userConfig?.clientSecret || null,
          refreshTokenToSave,
          calendarIdToSave,
          userConfig?.calendars || []
        );
        const note = tokens.refresh_token ? "" : "&note=existing_token_used";
        res.writeHead(302, { Location: `/?oauth=success${note}` });
        res.end();
      } else {
        res.writeHead(302, { Location: "/?oauth=error&msg=no_refresh_token" });
        res.end();
      }
    } catch (err: any) {
      console.error("Google OAuth Callback Error:", err);
      res.writeHead(302, { Location: `/?oauth=error&msg=${encodeURIComponent(err.message)}` });
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
  
  // セットアップ状態の確認
  if (pathname === "/api/setup/status" && method === "GET") {
    try {
      const users = listAllUsers();
      sendJson(res, 200, { needSetup: users.length === 0 });
    } catch (err: any) {
      console.error("セットアップ状態確認エラー:", err);
      sendError(res, 500, "システム状態の取得に失敗しました。");
    }
    return;
  }

  // 初期セットアップ実行
  if (pathname === "/api/setup" && method === "POST") {
    try {
      const users = listAllUsers();
      if (users.length > 0) {
        return sendError(res, 400, "システムは既にセットアップされています。");
      }

      const body = await getRequestBody(req);
      const { discordId, username, password, geminiApiKey } = JSON.parse(body);

      if (!discordId || !username || !password || !geminiApiKey) {
        return sendError(res, 400, "すべてのフィールド（Discord ID、ユーザーネーム、パスワード、Gemini API Key）を入力してください。");
      }

      const cleanDiscordId = discordId.trim();
      const cleanUsername = username.trim();

      const enc = encryptText(geminiApiKey.trim());

      // 1. 管理者ユーザーの登録 (最初の登録なので自動的に admin ロールになる)
      createUser(cleanDiscordId, cleanUsername, password, enc.encrypted, enc.iv, enc.authTag);

      // 2. セッショントークン生成と自動ログイン
      const sessionToken = crypto.randomBytes(32).toString("hex");
      activeSessions.set(sessionToken, { userId: cleanDiscordId, createdAt: Date.now() });

      setSessionCookie(res, req, sessionToken);
      sendJson(res, 200, { success: true, message: "管理者登録が完了しました。続いてデフォルトBotを設定してください。" });
    } catch (err: any) {
      console.error("初期セットアップエラー:", err);
      sendError(res, 500, "初期セットアップに失敗しました。");
    }
    return;
  }

  // 新規登録
  if (pathname === "/api/register" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { discordId, username, password, inviteCode, geminiApiKey } = JSON.parse(body);

      if (!discordId || !username || !password || !inviteCode || !geminiApiKey) {
        return sendError(res, 400, "すべてのフィールド（Discord ID、ユーザーネーム、パスワード、招待コード、Gemini API Key）を入力してください。");
      }

      const cleanDiscordId = discordId.trim();
      const cleanUsername = username.trim();

      if (getUserByDiscordId(cleanDiscordId)) {
        return sendError(res, 400, "このDiscord IDは既に登録されています。");
      }

      if (!isValidCode(inviteCode.trim())) {
        return sendError(res, 400, "無効な、または使用済みの招待コードです。");
      }

      const enc = encryptText(geminiApiKey.trim());

      // ユーザー作成
      createUser(cleanDiscordId, cleanUsername, password, enc.encrypted, enc.iv, enc.authTag);

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

        setSessionCookie(res, req, sessionToken);
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

  // 旧フロントエンド互換性：クエリパラメータに botId がない場合はデフォルトBot IDを設定
  if (!parsedUrl.searchParams.get("botId") || parsedUrl.searchParams.get("botId")?.trim() === "") {
    parsedUrl.searchParams.set("botId", "system_default");
  }

  // ──────────────────────────────────────────
  // C. 認証済みプライベートAPI
  // ──────────────────────────────────────────
  
  // ログアウト
  if (pathname === "/api/logout" && method === "POST") {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies["__Host-yuuka-session"] || cookies["yuuka-session"];
    if (sessionToken) {
      activeSessions.delete(sessionToken);
    }

    setSessionCookie(res, req, "", 0);
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
        role: user.role || "user",
      }
    });
    return;
  }

  // ── Bot管理API ──
  if (pathname === "/api/bots") {
    if (method === "GET") {
      try {
        const bots = listBotsForUser(userId);
        sendJson(res, 200, { success: true, bots });
      } catch (err: any) {
        sendError(res, 500, "Bot一覧の取得に失敗しました。");
      }
      return;
    }

    if (method === "POST") {
      try {
        const body = await getRequestBody(req);
        const { name, persona } = JSON.parse(body);
        if (!name || !name.trim()) {
          return sendError(res, 400, "Botの名前は必須です。");
        }

        const botId = `bot_${crypto.randomUUID()}`;
        const bot = createBot(botId, userId, name.trim(), persona ? persona.trim() : null);
        sendJson(res, 200, { success: true, bot, message: "Botを作成しました。" });
      } catch (err: any) {
        console.error("Bot作成エラー:", err);
        sendError(res, 500, "Botの作成に失敗しました。");
      }
      return;
    }

    if (method === "DELETE") {
      try {
        const body = await getRequestBody(req);
        const { botId } = JSON.parse(body);
        if (!botId) return sendError(res, 400, "Bot IDが必要です。");

        if (botId.startsWith("bot_default_") || botId === "system_default") {
          return sendError(res, 400, "デフォルトのBotは削除できません。");
        }

        // 所有者チェック
        const bot = getBotById(botId);
        if (!bot || bot.user_id !== userId) {
          return sendError(res, 403, "Botの所有者のみが削除できます。");
        }

        // 動作中のBotクライアントを停止
        stopCustomBot(botId);

        const ok = deleteBot(botId);
        sendJson(res, 200, { success: ok, message: "Botを削除しました。" });
      } catch (err: any) {
        console.error("Bot削除エラー:", err);
        sendError(res, 500, "Botの削除に失敗しました。");
      }
      return;
    }
  }

  // ── Discord プロフィール同期API ──
  if (pathname === "/api/bots/sync-discord" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId } = JSON.parse(body);
      if (!botId) return sendError(res, 400, "botId が必要です。");
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

      // カスタムクライアントまたはデフォルトクライアントを使用してBot情報を取得
      const botRecord = getBotById(botId);
      if (!botRecord) return sendError(res, 404, "Bot が見つかりません。");

      let botUser: { username: string; displayAvatarURL: () => string } | null = null;

      // カスタムBotクライアントが起動している場合
      const customClient = customClients.get(botId);
      if (customClient && customClient.user) {
        botUser = customClient.user;
      } else if (botRecord.discord_token_encrypted) {
        // トークンはあるがクライアント未起動の場合はエラー
        return sendError(res, 400, "Botクライアントが起動していません。先にBotを起動してください。");
      } else if (defaultBotClient.user) {
        // デフォルトBotクライアントを使用
        botUser = defaultBotClient.user;
      }

      if (!botUser) {
        return sendError(res, 503, "Discordクライアントが準備できていません。サーバーを確認してください。");
      }

      const username = botUser.username;
      const avatarUrl = botUser.displayAvatarURL();

      updateBotDiscordProfile(botId, username, avatarUrl);

      sendJson(res, 200, {
        success: true,
        discord_username: username,
        discord_avatar_url: avatarUrl,
        message: `Discordプロフィールを同期しました: ${username}`,
      });
    } catch (err: any) {
      console.error("Discord同期エラー:", err);
      sendError(res, 500, "Discord情報の同期に失敗しました。");
    }
    return;
  }

  // ── Botプロフィール編集API ──
  if (pathname === "/api/bots/profile" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, name, avatarUrl } = JSON.parse(body);
      if (!botId) return sendError(res, 400, "botId が必要です。");
      if (botId === "system_default") return sendError(res, 403, "デフォルトBotのプロフィールは変更できません。");

      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId) return sendError(res, 403, "Botの所有者のみが変更できます。");

      const cleanName = (name ?? "").trim();
      if (!cleanName) return sendError(res, 400, "Botの名前は必須です。");

      updateBotProfile(botId, cleanName, avatarUrl?.trim() || null);
      sendJson(res, 200, { success: true, message: "Botのプロフィールを更新しました。" });
    } catch (err: any) {
      sendError(res, 500, "Botプロフィールの更新に失敗しました。");
    }
    return;
  }

  // ── Botアクセス制限API ──
  if (pathname === "/api/bots/access" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, targetUserId, action } = JSON.parse(body);

      if (!botId || !targetUserId || !action) {
        return sendError(res, 400, "botId, targetUserId, action が必要です。");
      }

      // 所有者のみが権限を設定できる
      const bot = getBotById(botId);
      if (!bot || bot.user_id !== userId) {
        return sendError(res, 403, "Botの所有者のみがアクセス権限を設定できます。");
      }

      const db = getDb();
      if (action === "grant") {
        db.prepare("INSERT OR IGNORE INTO user_bot_access (user_id, bot_id) VALUES (?, ?)").run(targetUserId, botId);
        sendJson(res, 200, { success: true, message: `ユーザー ${targetUserId} にアクセス権限を付与しました。` });
      } else if (action === "revoke") {
        if (targetUserId === userId) {
          return sendError(res, 400, "自分自身の所有権は剥奪できません。");
        }
        db.prepare("DELETE FROM user_bot_access WHERE user_id = ? AND bot_id = ?").run(targetUserId, botId);
        sendJson(res, 200, { success: true, message: `ユーザー ${targetUserId} のアクセス権限を削除しました。` });
      } else {
        sendError(res, 400, "無効なアクションです。");
      }
    } catch (err: any) {
      console.error("Botアクセス設定エラー:", err);
      sendError(res, 500, "アクセス権限の設定に失敗しました。");
    }
    return;
  }

  // システムステータス（ボット個別）
  if (pathname === "/api/status" && method === "GET") {
    try {
      const botId = parsedUrl.searchParams.get("botId");
      if (!verifyBotAccess(userId, botId)) {
        return sendError(res, 403, "アクセス権限がありません。");
      }

      const db = getDb();
      
      const taskCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE bot_id = ?").get(botId) as { count: number };
      const pendingTaskCount = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE bot_id = ? AND status = 'pending'").get(botId) as { count: number };
      const scheduleCount = db.prepare("SELECT COUNT(*) as count FROM schedules WHERE bot_id = ?").get(botId) as { count: number };
      const expenseCount = db.prepare("SELECT COUNT(*) as count FROM expenses WHERE bot_id = ?").get(botId) as { count: number };

      // 優先度別の未完了タスク数
      const priorityRows = db.prepare(`
        SELECT priority, COUNT(*) as count 
        FROM tasks 
        WHERE bot_id = ? AND status = 'pending' 
        GROUP BY priority
      `).all(botId) as { priority: number; count: number }[];

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
          WHERE bot_id = ? AND date(start_at) = date(?)
        `).get(botId, dateStr) as { count: number };
        scheduleTrend.push(countRow ? countRow.count : 0);
      }

      // 経費の過去5日間の支出額推移 (4日前から今日まで)
      const expenseTrend: number[] = [];
      for (let i = 4; i >= 0; i--) {
        const dateStr = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const sumRow = db.prepare(`
          SELECT SUM(amount) as total 
          FROM expenses 
          WHERE bot_id = ? AND date = ?
        `).get(botId, dateStr) as { total: number | null };
        expenseTrend.push(sumRow && sumRow.total ? sumRow.total : 0);
      }

      const googleConfig = getBotGoogleConfig(botId!);
      const geminiConfig = botId === "system_default"
        ? getUserGeminiConfig(userId)
        : getBotGeminiConfig(botId!);
      const botRecord = getBotById(botId!);

      // 利用可能なカレンダー一覧をフェッチ (OAuth設定済みの場合のみ)
      const calendars = googleConfig?.clientId && googleConfig?.clientSecret && googleConfig?.refreshToken
        ? await getCachedCalendars(botId!)
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
          username: botRecord?.name || userId,
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
          backupEnabled: botRecord?.google_drive_backup_enabled === 1,
          backupFolderId: mask(botRecord?.google_drive_backup_folder_id ?? null),
          backupCron: botRecord?.backup_cron || "0 3 * * *",
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
      const { botId, apiKey, model } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!model) return sendError(res, 400, "モデル名は必須項目です。");

      const current = botId === "system_default"
        ? getUserGeminiConfig(userId)
        : getBotGeminiConfig(botId);
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

      if (botId === "system_default") {
        updateUserGeminiSettings(userId, encrypted, iv, tag, model.trim());
      } else {
        updateBotGeminiSettings(botId, encrypted, iv, tag, model.trim());
      }
      sendJson(res, 200, { success: true, message: "Gemini 設定を更新しました。" });
    } catch (err: any) {
      console.error("Gemini 設定更新エラー:", err);
      sendError(res, 500, "Gemini 設定の更新に失敗しました。");
    }
    return;
  }

  // Discord 独自Bot & ペルソナ設定取得
  if (pathname === "/api/settings/discord" && method === "GET") {
    try {
      const botId = parsedUrl.searchParams.get("botId");
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

      const current = getBotDiscordConfig(botId!);
      const hasToken = !!(current?.tokenEncrypted && current?.tokenIv && current?.tokenTag);
      const tokenMasked = hasToken ? "••••••••••••" : "";
      
      sendJson(res, 200, {
        success: true,
        hasToken,
        tokenMasked,
        persona: current?.persona ?? "",
      });
    } catch (err: any) {
      console.error("Discord 設定取得エラー:", err);
      sendError(res, 500, "Discord 設定の取得に失敗しました。");
    }
    return;
  }

  // Discord 独自Bot & ペルソナ設定更新
  if (pathname === "/api/settings/discord" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, token, persona } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

      if (botId === "system_default" && !verifyAdmin(userId)) {
        return sendError(res, 403, "システムBotのDiscord設定は管理者のみ変更可能です。");
      }

      const current = getBotDiscordConfig(botId);
      let encrypted: string | null = null;
      let iv: string | null = null;
      let tag: string | null = null;
      let tokenChanged = false;
      let tokenCleared = false;

      // トークンの処理
      if (token === undefined || token === null || token.trim() === "") {
        // 空欄の場合はクリア（削除）
        encrypted = null;
        iv = null;
        tag = null;
        if (current?.tokenEncrypted) {
          tokenChanged = true;
          tokenCleared = true;
        }
      } else if (token.startsWith("••••") || token.startsWith("••••••••••••")) {
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

      // ペルソナの処理 (空欄の場合は null にする)
      const personaVal = (persona && persona.trim() !== "") ? persona.trim() : null;

      const botRecord = getBotById(botId)!;
      // データベースを更新
      updateBotSettings(botId, botRecord.name, encrypted, iv, tag, personaVal);

      // トークンがクリアされた場合、動作中の独自Botを完全にクローズする
      if (tokenCleared) {
        stopCustomBot(botId);
      }

      // トークンが変更された場合、新しいBotを非同期でログイン・動的起動する
      let botStartupMessage = "";
      if (tokenChanged && encrypted !== null) {
        // 差し押さえ中のBotは起動できない
        if (isBotSuspended(botId)) {
          botStartupMessage = " このBotは管理者により差し押さえられているため、起動できません。";
        } else {
          console.log(`[Discord Bot] Bot ${botId} の独自Botの再起動を試みます...`);
          const startupSuccess = await startCustomBot(botId);
          if (!startupSuccess) {
            botStartupMessage = " 設定は保存されましたが、独自Botの起動に失敗しました。トークンが有効か再度ご確認ください。";
          }
        }
      }

      sendJson(res, 200, { 
        success: true, 
        message: `設定を保存しました。${botStartupMessage}`.trim() 
      });
    } catch (err: any) {
      console.error("Discord 設定更新エラー:", err);
      sendError(res, 500, "Discord 設定の更新に失敗しました。");
    }
    return;
  }

  // Google OAuth URL 生成
  if (pathname === "/api/settings/google/oauth/url" && method === "GET") {
    const botId = parsedUrl.searchParams.get("botId");
    if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

    const userConfig = getBotGoogleConfig(botId!);
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
        state: botId!,
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
      const { botId, calendars } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!Array.isArray(calendars)) {
        return sendError(res, 400, "カレンダーリストは配列形式で指定してください。");
      }

      const current = getBotGoogleConfig(botId);
      updateBotGoogleSettings(
        botId,
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
      const { botId, enabled, folderId, cron } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

      updateBotBackupSettings(botId, enabled, folderId || null, cron || "0 3 * * *");

      const { initBotBackupSchedule } = await import("./services/backupService.js");
      initBotBackupSchedule(botId);

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
      const body = await getRequestBody(req);
      const { botId } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

      const bot = getBotById(botId);
      if (!bot || !bot.google_drive_backup_enabled) {
        return sendError(res, 400, "バックアップ設定が無効になっています。");
      }

      const { runBackup } = await import("./services/backupService.js");
      const url = await runBackup(botId);

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
      const botId = parsedUrl.searchParams.get("botId");
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");

      const list = secretService.listCredentials(botId!);
      sendJson(res, 200, { success: true, credentials: list });
    } catch (err: any) {
      sendError(res, 500, "資格情報一覧の取得に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/credentials/register" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, serviceName, username, password } = JSON.parse(body);

      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!serviceName || !username || !password) {
        return sendError(res, 400, "サービス名、ユーザー名、およびパスワードは必須です。");
      }

      secretService.registerCredential(botId, serviceName, username, password);
      sendJson(res, 200, { success: true, message: "資格情報を正常に登録しました。" });
    } catch (err: any) {
      sendError(res, 500, "資格情報の登録に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/credentials/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, serviceName } = JSON.parse(body);

      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!serviceName) {
        return sendError(res, 400, "サービス名は必須です。");
      }

      const success = secretService.deleteCredential(botId, serviceName);
      sendJson(res, 200, { success });
    } catch (err: any) {
      sendError(res, 500, "資格情報の削除に失敗しました。");
    }
    return;
  }

  // ── プレイブックAPI ──
  if (pathname === "/api/playbooks" && method === "GET") {
    try {
      const botId = parsedUrl.searchParams.get("botId");
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      const query = parsedUrl.searchParams.get("query") || undefined;
      const list = findPlaybooks(botId!, query);
      sendJson(res, 200, { success: true, playbooks: list });
    } catch (err: any) {
      sendError(res, 500, "手順書一覧の取得に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/playbooks/save" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, name, title, keywords, description, steps } = JSON.parse(body);

      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!name || !title || !steps) {
        return sendError(res, 400, "手順書名、タイトル、および手順ステップは必須です。");
      }

      const keywordsList = Array.isArray(keywords) ? keywords : [];
      const result = savePlaybook(botId, name, title, keywordsList, description || "", steps);
      sendJson(res, 200, result);
    } catch (err: any) {
      sendError(res, 500, "手順書の保存に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/playbooks/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, name } = JSON.parse(body);

      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません. ");
      if (!name) {
        return sendError(res, 400, "手順書名は必須です。");
      }

      const success = deletePlaybook(botId, name);
      sendJson(res, 200, { success, message: success ? "手順書を削除しました。" : "削除に失敗しました。" });
    } catch (err: any) {
      sendError(res, 500, "手順書の削除に失敗しました。");
    }
    return;
  }


  // ── タスクAPI ──
  if (pathname === "/api/tasks") {
    if (method === "GET") {
      try {
        const botId = parsedUrl.searchParams.get("botId");
        if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
        const status = parsedUrl.searchParams.get("status") || "all";
        const tasks = listTasks(botId!, status);
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
      const { botId, title, description, dueDate, priority } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!title) return sendError(res, 400, "タイトルは必須です。");

      const task = addTask(botId, title, description, dueDate, priority);
      sendJson(res, 200, { success: true, task });
    } catch (err: any) {
      sendError(res, 500, "タスクの追加に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/tasks/complete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, id } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!id) return sendError(res, 400, "IDが必要です。");

      const task = completeTask(id, botId);
      sendJson(res, 200, { success: true, task });
    } catch (err: any) {
      sendError(res, 500, "タスクの完了処理に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/tasks/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, id } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!id) return sendError(res, 400, "IDが必要です。");

      const ok = deleteTask(id, botId);
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
        const botId = parsedUrl.searchParams.get("botId");
        if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
        const days = parseInt(parsedUrl.searchParams.get("days") || "7", 10);
        const schedules = listUpcomingSchedules(botId!, days);
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
      const { botId, title, startAt, endAt, remindBeforeMinutes, description } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!title || !startAt) return sendError(res, 400, "タイトルと開始日時は必須です。");

      const schedule = addSchedule(
        botId,
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
      const { botId, id } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!id) return sendError(res, 400, "IDが必要です。");

      const ok = deleteSchedule(id, botId);
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
        const botId = parsedUrl.searchParams.get("botId");
        if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
        const now = new Date();
        const year = parseInt(parsedUrl.searchParams.get("year") || String(now.getFullYear()), 10);
        const month = parseInt(parsedUrl.searchParams.get("month") || String(now.getMonth() + 1), 10);
        
        const recent = listRecentExpenses(botId!, 30);
        const total = getMonthlyTotal(botId!, year, month);
        const breakdown = getMonthlyCategoryBreakdown(botId!, year, month);

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
      const { botId, amount, category, description, date, time } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!amount || !category) return sendError(res, 400, "金額とカテゴリは必須です。");

      const expense = addExpense(
        botId,
        amount,
        category,
        description,
        date,
        time,
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
      const { botId, imageBase64, mimeType, additionalText } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!imageBase64 || !mimeType) {
        return sendError(res, 400, "画像データ(base64)とMIMEタイプが必要です。");
      }

      console.log(`📸 [Bot: ${botId}] WEB管理画面より画像解析要求を受信 (MIME: ${mimeType})`);
      const response = await parseReceipt(botId, imageBase64, mimeType, additionalText);
      sendJson(res, 200, { success: true, response });
    } catch (err: any) {
      console.error("WEBレシート解析エラー:", err);
      sendError(res, 500, "レシート解析中にエラーが発生しました。");
    }
    return;
  }

  // ── 予算上限API ──
  if (pathname === "/api/expenses/budget-limits" && method === "GET") {
    try {
      const botId = parsedUrl.searchParams.get("botId");
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      const limits = getBudgetLimits(botId!);
      sendJson(res, 200, { success: true, limits });
    } catch (err: any) {
      sendError(res, 500, "予算上限の取得に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/expenses/budget-limits" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, category, limitAmount } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!category || limitAmount === undefined) return sendError(res, 400, "category と limitAmount は必須です。");
      if (typeof limitAmount !== "number" || limitAmount < 0) return sendError(res, 400, "limitAmount は0以上の数値で指定してください。");
      upsertBudgetLimit(botId, category, limitAmount);
      sendJson(res, 200, { success: true, message: `${category} の予算上限を ¥${limitAmount.toLocaleString()} に設定しました。` });
    } catch (err: any) {
      sendError(res, 500, "予算上限の更新に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/expenses/budget-limits/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, category } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!category) return sendError(res, 400, "category は必須です。");
      deleteBudgetLimit(botId, category);
      sendJson(res, 200, { success: true, message: `${category} の予算上限を削除しました。` });
    } catch (err: any) {
      sendError(res, 500, "予算上限の削除に失敗しました。");
    }
    return;
  }

  // ── 支払い予定API ──
  if (pathname === "/api/expenses/plans" && method === "GET") {
    try {
      const botId = parsedUrl.searchParams.get("botId");
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      const includePaid = parsedUrl.searchParams.get("includePaid") === "true";
      const plans = listExpensePlans(botId!, includePaid);
      sendJson(res, 200, { success: true, plans });
    } catch (err: any) {
      sendError(res, 500, "支払い予定の取得に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/expenses/plans/add" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, title, amount, category, plannedDate, description } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!title || !amount || !category || !plannedDate) return sendError(res, 400, "title、amount、category、plannedDate は必須です。");
      const plan = addExpensePlan(botId, title, Number(amount), category, plannedDate, description);
      sendJson(res, 200, { success: true, plan });
    } catch (err: any) {
      sendError(res, 500, "支払い予定の追加に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/expenses/plans/pay" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, id } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!id) return sendError(res, 400, "id は必須です。");

      const plan = listExpensePlans(botId, true).find(p => p.id === Number(id));
      if (!plan) return sendError(res, 404, "支払い予定が見つかりません。");
      if (plan.is_paid) return sendError(res, 400, "既に支払い済みです。");

      const expense = addExpense(botId, plan.amount, plan.category, plan.title, undefined, undefined, "plan");
      markExpensePlanPaid(Number(id), botId, expense.id);
      sendJson(res, 200, { success: true, expense, message: `「${plan.title}」の支払いを完了しました。` });
    } catch (err: any) {
      sendError(res, 500, "支払い完了処理に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/expenses/plans/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { botId, id } = JSON.parse(body);
      if (!verifyBotAccess(userId, botId)) return sendError(res, 403, "アクセス権限がありません。");
      if (!id) return sendError(res, 400, "id は必須です。");
      const ok = deleteExpensePlan(Number(id), botId);
      sendJson(res, 200, { success: ok });
    } catch (err: any) {
      sendError(res, 500, "支払い予定の削除に失敗しました。");
    }
    return;
  }

  // ──────────────────────────────────────────
  // D. Admin 管理API (Admin ロール必須)
  // ──────────────────────────────────────────

  // Admin API: デフォルトBotのトークン更新
  if (pathname === "/api/admin/default-bot/token" && method === "POST") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const body = await getRequestBody(req);
      const { token } = JSON.parse(body);

      if (!token) {
        return sendError(res, 400, "トークンを入力してください。");
      }

      const cleanToken = token.trim();

      // 1. システムデフォルトBotトークンの暗号化と保存
      const enc = encryptText(cleanToken);
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO bots (
          id, user_id, name, discord_token_encrypted, discord_token_iv, discord_token_tag, suspended
        ) VALUES ('system_default', ?, 'システムデフォルト', ?, ?, ?, 0)
      `).run(userId, enc.encrypted, enc.iv, enc.authTag);

      db.prepare(`
        INSERT OR IGNORE INTO user_bot_access (user_id, bot_id)
        VALUES (?, 'system_default')
      `).run(userId);

      // 2. システムデフォルトBotの再起動
      await restartDefaultBot(cleanToken);

      sendJson(res, 200, { success: true, message: "デフォルトBotのトークンを更新しました。" });
    } catch (err: any) {
      console.error("デフォルトBotトークン更新エラー:", err);
      sendError(res, 500, "デフォルトBotトークンの更新に失敗しました。");
    }
    return;
  }

  // Admin API: システム全体の統計
  if (pathname === "/api/admin/stats" && method === "GET") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const db = getDb();
      const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
      const botCount = db.prepare("SELECT COUNT(*) as count FROM bots").get() as { count: number };
      const suspendedBotCount = db.prepare("SELECT COUNT(*) as count FROM bots WHERE suspended = 1").get() as { count: number };
      const inviteTotal = db.prepare("SELECT COUNT(*) as count FROM invite_codes").get() as { count: number };
      const inviteUsed = db.prepare("SELECT COUNT(*) as count FROM invite_codes WHERE used_by IS NOT NULL").get() as { count: number };

      sendJson(res, 200, {
        success: true,
        stats: {
          totalUsers: userCount.count,
          totalBots: botCount.count,
          suspendedBots: suspendedBotCount.count,
          totalInviteCodes: inviteTotal.count,
          usedInviteCodes: inviteUsed.count,
          availableInviteCodes: inviteTotal.count - inviteUsed.count,
        }
      });
    } catch (err: any) {
      console.error("Admin 統計取得エラー:", err);
      sendError(res, 500, "統計情報の取得に失敗しました。");
    }
    return;
  }

  // Admin API: 全ユーザー一覧
  if (pathname === "/api/admin/users" && method === "GET") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const users = listAllUsers();
      sendJson(res, 200, { success: true, users });
    } catch (err: any) {
      console.error("Admin ユーザー一覧取得エラー:", err);
      sendError(res, 500, "ユーザー一覧の取得に失敗しました。");
    }
    return;
  }

  // Admin API: ユーザーロール変更
  if (pathname === "/api/admin/users/role" && method === "POST") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const body = await getRequestBody(req);
      const { targetUserId, role } = JSON.parse(body);

      if (!targetUserId || !role) {
        return sendError(res, 400, "targetUserId と role が必要です。");
      }

      if (role !== "user" && role !== "admin") {
        return sendError(res, 400, "role は 'user' または 'admin' のみ指定可能です。");
      }

      // 自己降格防止
      if (targetUserId === userId && role === "user") {
        return sendError(res, 400, "自分自身の Admin 権限を解除することはできません。");
      }

      const success = updateUserRole(targetUserId, role);
      if (success) {
        sendJson(res, 200, { success: true, message: `ユーザー ${targetUserId} のロールを ${role} に変更しました。` });
      } else {
        sendError(res, 400, "ロールの変更に失敗しました。ユーザーが存在しない可能性があります。");
      }
    } catch (err: any) {
      console.error("Admin ロール変更エラー:", err);
      sendError(res, 500, "ロールの変更に失敗しました。");
    }
    return;
  }

  // Admin API: 全Bot一覧
  if (pathname === "/api/admin/bots" && method === "GET") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const bots = listAllBots();
      // 所有者名を取得して付与（機密情報は除外）
      const botsWithOwner = bots.map(bot => {
        const owner = getUserByDiscordId(bot.user_id);
        return {
          id: bot.id,
          name: bot.name,
          user_id: bot.user_id,
          owner_username: owner?.username || "不明",
          discord_username: bot.discord_username,
          discord_avatar_url: bot.discord_avatar_url,
          suspended: bot.suspended,
          hasCustomToken: !!(bot.discord_token_encrypted),
          isRunning: customClients.has(bot.id),
          created_at: bot.created_at,
          updated_at: bot.updated_at,
        };
      });
      sendJson(res, 200, { success: true, bots: botsWithOwner });
    } catch (err: any) {
      console.error("Admin Bot一覧取得エラー:", err);
      sendError(res, 500, "Bot一覧の取得に失敗しました。");
    }
    return;
  }

  // Admin API: Bot差し押さえ
  if (pathname === "/api/admin/bots/suspend" && method === "POST") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const body = await getRequestBody(req);
      const { botId } = JSON.parse(body);
      if (!botId) return sendError(res, 400, "botId が必要です。");

      // 動作中のBotクライアントを停止
      stopCustomBot(botId);

      const success = suspendBot(botId);
      if (success) {
        console.log(`🚫 [Admin: ${userId}] Bot ${botId} を差し押さえました`);
        sendJson(res, 200, { success: true, message: `Bot ${botId} を差し押さえました。Discordクライアントは停止されました。` });
      } else {
        sendError(res, 400, "Botの差し押さえに失敗しました。");
      }
    } catch (err: any) {
      console.error("Admin Bot差し押さえエラー:", err);
      sendError(res, 500, "Botの差し押さえに失敗しました。");
    }
    return;
  }

  // Admin API: Bot差し押さえ解除
  if (pathname === "/api/admin/bots/unsuspend" && method === "POST") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const body = await getRequestBody(req);
      const { botId } = JSON.parse(body);
      if (!botId) return sendError(res, 400, "botId が必要です。");

      const success = unsuspendBot(botId);
      if (success) {
        console.log(`✅ [Admin: ${userId}] Bot ${botId} の差し押さえを解除しました`);
        sendJson(res, 200, { success: true, message: `Bot ${botId} の差し押さえを解除しました。所有者が再起動できるようになりました。` });
      } else {
        sendError(res, 400, "差し押さえ解除に失敗しました。");
      }
    } catch (err: any) {
      console.error("Admin Bot差し押さえ解除エラー:", err);
      sendError(res, 500, "差し押さえ解除に失敗しました。");
    }
    return;
  }

  // Admin API: 招待コード一覧
  if (pathname === "/api/admin/invite-codes" && method === "GET") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const codes = listInviteCodes();
      sendJson(res, 200, { success: true, codes });
    } catch (err: any) {
      console.error("Admin 招待コード一覧取得エラー:", err);
      sendError(res, 500, "招待コード一覧の取得に失敗しました。");
    }
    return;
  }

  // Admin API: 招待コード新規作成
  if (pathname === "/api/admin/invite-codes" && method === "POST") {
    if (!verifyAdmin(userId)) return sendError(res, 403, "管理者権限が必要です。");

    try {
      const body = await getRequestBody(req);
      const { code } = JSON.parse(body);
      if (!code || !code.trim()) {
        return sendError(res, 400, "招待コードを入力してください。");
      }

      const cleanCode = code.trim();
      createInviteCode(cleanCode, userId);
      sendJson(res, 200, { success: true, message: `招待コード「${cleanCode}」を作成しました。` });
    } catch (err: any) {
      console.error("Admin 招待コード作成エラー:", err);
      sendError(res, 500, "招待コードの作成に失敗しました。");
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
        import("./db/botRepo.js").then((botMod) => {
          const botIds = botMod.listAllBotIds();
          mod.initAllBackupSchedules(botIds);
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
