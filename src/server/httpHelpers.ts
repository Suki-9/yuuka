import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.js";
import { getSession } from "../services/sessionService.js";
import type { SessionUser } from "../types/contracts.js";

// ─── HTTP共通ヘルパー（server.ts と server/routes/* で共用） ──────────────────

/**
 * リクエストが HTTPS 経由であるかどうかを判別する
 */
export function checkHttps(req: IncomingMessage): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isForwardedHttps = typeof forwardedProto === "string" && forwardedProto.toLowerCase() === "https";
  const isEncrypted = !!(req.socket as unknown as { encrypted?: boolean }).encrypted;

  return isForwardedHttps || isEncrypted;
}

/**
 * クッキー文字列をオブジェクトにパースするヘルパー
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
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

/** リクエストからセッショントークンを取り出す */
export function getSessionToken(req: IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies["__Host-yuuka-session"] || cookies["yuuka-session"] || null;
}

/**
 * セッションクッキーをレスポンスにセットする
 * maxAge=0 を指定するとクッキーを削除（ログアウト）する
 */
export function setSessionCookie(
  res: ServerResponse,
  req: IncomingMessage,
  token: string,
  maxAge?: number
): void {
  const isHttps = checkHttps(req);
  const name = isHttps ? "__Host-yuuka-session" : "yuuka-session";
  const secure = isHttps ? "; Secure" : "";
  const expires =
    maxAge !== undefined ? `; Max-Age=${maxAge}` : `; Max-Age=${config.sessionTtlDays * 24 * 60 * 60}`;
  res.setHeader("Set-Cookie", `${name}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax${expires}`);
}

/**
 * セッションの妥当性をチェックし、セッションユーザーを返す（§5.4.2）
 * Redis保存・7日間スライディングウィンドウ（getSession がTTLを自動延長する）
 */
export async function getSessionUser(req: IncomingMessage): Promise<SessionUser | null> {
  const token = getSessionToken(req);
  if (!token) return null;
  try {
    return await getSession(token);
  } catch {
    return null;
  }
}
