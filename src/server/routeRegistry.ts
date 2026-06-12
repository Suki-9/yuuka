import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteDef, RouteRequestCtx, SessionUser } from "../types/contracts.js";
import { sendJson } from "../types/contracts.js";

// 登録済みルート（モジュール起動時に registerRoutes で追加される）
const routes: RouteDef[] = [];

/** ルートモジュールの RouteDef[] をレジストリへ登録する */
export function registerRoutes(defs: RouteDef[]): void {
  for (const def of defs) {
    routes.push(def);
  }
}

/** "/hook/:token" のようなパターンとパスを照合し、パラメータを抽出する */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter((p) => p !== "");
  const pathParts = pathname.split("/").filter((p) => p !== "");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (pp !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB（レシート画像base64等を考慮）

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("リクエストボディが大きすぎます"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 登録済みルートへのディスパッチを試みる。
 * @param resolveUser セッションからユーザーを解決するコールバック（server.ts の既存セッション機構を注入）
 * @returns ルートが処理した場合 true（server.ts はそれ以上処理しない）
 */
export async function dispatchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  resolveUser: () => Promise<SessionUser | null> | SessionUser | null
): Promise<boolean> {
  const method = (req.method || "GET").toUpperCase();

  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, url.pathname);
    if (params === null) continue;

    // 認可チェック
    let user: SessionUser | null = null;
    if (route.auth !== "none") {
      user = await resolveUser();
      if (!user) {
        sendJson(res, 401, { success: false, message: "認証が必要です" });
        return true;
      }
      if (route.auth === "admin" && user.role !== "admin") {
        sendJson(res, 403, { success: false, message: "管理者権限が必要です" });
        return true;
      }
    } else {
      // 公開ルートでもセッションがあれば取得しておく（任意利用）
      try {
        user = await resolveUser();
      } catch {
        user = null;
      }
    }

    // ボディの読み込み（POST/DELETE のみ）
    let rawBody: Buffer = Buffer.alloc(0);
    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "DELETE") {
      try {
        rawBody = await readBody(req);
        if (rawBody.length > 0) {
          try {
            const parsed = JSON.parse(rawBody.toString("utf-8"));
            if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
          } catch {
            // JSONでないボディ（Webhookの生ペイロード等）は rawBody のみ提供
          }
        }
      } catch (err) {
        sendJson(res, 413, { success: false, message: (err as Error).message });
        return true;
      }
    }

    const ctx: RouteRequestCtx = { req, res, url, user, body, rawBody, params };

    try {
      await route.handler(ctx);
    } catch (err) {
      console.error(`[Route] ${method} ${url.pathname} の処理中にエラーが発生しました:`, err);
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, message: "内部エラーが発生しました" });
      }
    }
    return true;
  }

  return false;
}
