import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, updateGoogleCalendarsInYaml } from "./config.js";
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

// セッション管理（有効期限付き）
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24時間
const activeSessions = new Map<string, number>(); // token -> 作成時刻(ms)

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
 * クッキーのパースからセッションの妥当性をチェックする
 */
function isAuthenticated(req: http.IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies["__Host-yuuka-session"];
  if (!sessionToken || !activeSessions.has(sessionToken)) return false;

  const createdAt = activeSessions.get(sessionToken)!;
  if (Date.now() - createdAt > SESSION_TTL) {
    activeSessions.delete(sessionToken);
    return false;
  }
  return true;
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
  const urlPath = req.url === "/" || !req.url ? "/index.html" : req.url;
  
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
  res.setHeader("Access-Control-Allow-Origin", "null"); // 厳格化

  // 2. 静的ファイルのハンドリング (APIでなければすべて静的ファイルとして処理)
  if (!pathname.startsWith("/api/")) {
    // ログインページへの自動リダイレクト (認証がない場合はログイン用HTMLを表示するなどの処理はフロント側で行う)
    serveStaticFile(req, res);
    return;
  }

  // 3. APIルート

  // ──────────────────────────────────────────
  // A. パブリックAPI (ログイン)
  // ──────────────────────────────────────────
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
      const { passcode } = JSON.parse(body);

      if (passcode === config.adminToken) {
        // ログイン成功：試行カウントをリセット
        loginAttempts.delete(clientIp);

        // 安全なランダムセッショントークンの生成
        const sessionToken = crypto.randomBytes(32).toString("hex");
        activeSessions.set(sessionToken, Date.now());

        // 安全な __Host- クッキーの設定 (HttpOnly, Secure, SameSite=Lax, Path=/)
        res.setHeader(
          "Set-Cookie",
          `__Host-yuuka-session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax`
        );

        sendJson(res, 200, { success: true, message: "ログインに成功しました！" });
      } else {
        // ログイン失敗：試行カウントを記録
        const current = loginAttempts.get(clientIp) || { count: 0, resetAt: 0 };
        current.count += 1;
        current.resetAt = Date.now() + LOGIN_LOCKOUT_MS;
        loginAttempts.set(clientIp, current);

        sendError(res, 401, "パスコードが正しくありません。");
      }
    } catch (err: any) {
      sendError(res, 400, "リクエストフォーマットが不正です。");
    }
    return;
  }

  // ──────────────────────────────────────────
  // B. プライベートAPI用認証ガード
  // ──────────────────────────────────────────
  if (!isAuthenticated(req)) {
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

  // システムステータス
  if (pathname === "/api/status" && method === "GET") {
    try {
      const db = getDb();
      const userId = parsedUrl.searchParams.get("userId") || "sensei_default";
      
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

      // 利用可能なカレンダー一覧をフェッチ (キャッシュ付き)
      const calendars = await getCachedCalendars();

      // クレデンシャルの安全なマスキング
      const mask = (str: string) => {
        if (!str) return "未設定";
        if (str.length <= 8) return "****";
        return str.substring(0, 4) + "..." + str.substring(str.length - 4);
      };

      sendJson(res, 200, {
        success: true,
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
          guildId: config.guildId,
          dbPath: config.dbPath,
          reminderCron: config.reminderCron,
          googleCalendarId: config.googleCalendarId,
          googleServiceAccountEmail: mask(config.googleServiceAccountEmail),
          googleClientId: mask(config.googleClientId),
          googleCalendars: calendars,
        }
      });
    } catch (err: any) {
      console.error("ステータス取得エラー:", err);
      sendError(res, 500, "ステータス取得に失敗しました。");
    }
    return;
  }

  // カレンダー追加API
  if (pathname === "/api/config/calendars/add" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { calendarId } = JSON.parse(body);
      if (!calendarId || typeof calendarId !== "string" || !calendarId.trim()) {
        return sendError(res, 400, "有効なカレンダーIDを指定してください。");
      }
      const cleanId = calendarId.trim();

      const current = [...(config.googleCalendars || [])];
      if (current.includes(cleanId)) {
        return sendJson(res, 200, { success: true, message: "このカレンダーIDは既に登録されています。" });
      }

      current.push(cleanId);
      updateGoogleCalendarsInYaml(current);

      sendJson(res, 200, { success: true, message: "カレンダーIDを追加しました。" });
    } catch (err: any) {
      console.error("カレンダー追加エラー:", err);
      sendError(res, 500, "カレンダーの追加に失敗しました。");
    }
    return;
  }

  // カレンダー削除API
  if (pathname === "/api/config/calendars/delete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { calendarId } = JSON.parse(body);
      if (!calendarId || typeof calendarId !== "string" || !calendarId.trim()) {
        return sendError(res, 400, "有効なカレンダーIDを指定してください。");
      }
      const cleanId = calendarId.trim();

      const current = (config.googleCalendars || []).filter((id: string) => id !== cleanId);
      updateGoogleCalendarsInYaml(current);

      sendJson(res, 200, { success: true, message: "カレンダーIDを削除しました。" });
    } catch (err: any) {
      console.error("カレンダー削除エラー:", err);
      sendError(res, 500, "カレンダーの削除に失敗しました。");
    }
    return;
  }

  // ユニークユーザーリスト (プロファイル切り替え用)
  if (pathname === "/api/users" && method === "GET") {
    try {
      const db = getDb();
      const usersRows = db.prepare(`
        SELECT DISTINCT user_id FROM tasks 
        UNION 
        SELECT DISTINCT user_id FROM schedules 
        UNION 
        SELECT DISTINCT user_id FROM expenses
      `).all() as { user_id: string }[];
      
      const userIds = usersRows.map(r => r.user_id).filter(id => id && id.trim() !== "");
      // 初期データが無い場合のデフォルト追加
      if (userIds.length === 0) {
        userIds.push("sensei_default");
      }
      
      sendJson(res, 200, { success: true, users: userIds });
    } catch (err: any) {
      sendError(res, 500, "ユーザー一覧の取得に失敗しました。");
    }
    return;
  }

  // ── タスクAPI ──
  if (pathname === "/api/tasks") {
    const userId = parsedUrl.searchParams.get("userId") || "sensei_default";

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
      const { userId, title, description, dueDate, priority } = JSON.parse(body);
      if (!title) return sendError(res, 400, "タイトルは必須です。");

      const task = addTask(userId || "sensei_default", title, description, dueDate, priority);
      sendJson(res, 200, { success: true, task });
    } catch (err: any) {
      sendError(res, 500, "タスクの追加に失敗しました。");
    }
    return;
  }

  if (pathname === "/api/tasks/complete" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { id, userId } = JSON.parse(body);
      if (!id || !userId) return sendError(res, 400, "IDとユーザーIDが必要です。");

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
      const { id, userId } = JSON.parse(body);
      if (!id || !userId) return sendError(res, 400, "IDとユーザーIDが必要です。");

      const ok = deleteTask(id, userId);
      sendJson(res, 200, { success: ok });
    } catch (err: any) {
      sendError(res, 500, "タスクの削除に失敗しました。");
    }
    return;
  }

  // ── スケジュールAPI ──
  if (pathname === "/api/schedules") {
    const userId = parsedUrl.searchParams.get("userId") || "sensei_default";

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
      const { userId, title, startAt, endAt, remindBeforeMinutes, description } = JSON.parse(body);
      if (!title || !startAt) return sendError(res, 400, "タイトルと開始日時は必須です。");

      const schedule = addSchedule(
        userId || "sensei_default",
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
      const { id, userId } = JSON.parse(body);
      if (!id || !userId) return sendError(res, 400, "IDとユーザーIDが必要です。");

      const ok = deleteSchedule(id, userId);
      sendJson(res, 200, { success: ok });
    } catch (err: any) {
      sendError(res, 500, "予定の削除に失敗しました。");
    }
    return;
  }

  // ── 家計簿API ──
  if (pathname === "/api/expenses") {
    const userId = parsedUrl.searchParams.get("userId") || "sensei_default";

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
      const { userId, amount, category, description, date } = JSON.parse(body);
      if (!amount || !category) return sendError(res, 400, "金額とカテゴリは必須です。");

      const expense = addExpense(
        userId || "sensei_default",
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

  // レシート解析の呼び出しAPI
  if (pathname === "/api/expenses/upload-receipt" && method === "POST") {
    try {
      const body = await getRequestBody(req);
      const { userId, imageBase64, mimeType, additionalText } = JSON.parse(body);
      if (!imageBase64 || !mimeType) {
        return sendError(res, 400, "画像データ(base64)とMIMEタイプが必要です。");
      }

      console.log(`📸 WEB管理画面より画像解析要求を受信 (MIME: ${mimeType})`);
      const response = await parseReceipt(userId || "sensei_default", imageBase64, mimeType, additionalText);
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
