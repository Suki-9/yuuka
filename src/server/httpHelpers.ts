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
	const isForwardedHttps =
		typeof forwardedProto === "string" &&
		forwardedProto.toLowerCase() === "https";
	const isEncrypted = !!(req.socket as unknown as { encrypted?: boolean })
		.encrypted;

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

/** HTTPS本番デプロイか（BASE_URL が https）。Cookieのハードニング判定に使う。 */
function isHttpsDeployment(): boolean {
	return (
		!!config.baseUrl && config.baseUrl.toLowerCase().startsWith("https://")
	);
}

/** リクエストからセッショントークンを取り出す */
export function getSessionToken(req: IncomingMessage): string | null {
	const cookies = parseCookies(req.headers.cookie);
	// HTTPS本番では Secure な __Host- 付きCookieのみを受理し、非Secure名は無視する
	if (isHttpsDeployment()) {
		return cookies["__Host-yuuka-session"] || null;
	}
	return cookies["__Host-yuuka-session"] || cookies["yuuka-session"] || null;
}

/**
 * クライアントの実IPを取得する（レート制限等の識別に使用）。
 * 直前のpeerが config.trustedProxies に含まれる場合のみ X-Forwarded-For を信頼し、
 * 右端（直近プロキシが付与した側）から最初の「信頼プロキシでない」アドレスを採用する。
 * 信頼プロキシ未設定時は socket.remoteAddress のみを信頼する（XFFは攻撃者が偽装可能なため）。
 */
export function getClientIp(req: IncomingMessage): string {
	const peer = req.socket.remoteAddress || "unknown";
	if (
		config.trustedProxies.length > 0 &&
		config.trustedProxies.includes(peer)
	) {
		const xff = req.headers["x-forwarded-for"];
		if (typeof xff === "string" && xff.trim()) {
			const parts = xff
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			for (let i = parts.length - 1; i >= 0; i--) {
				if (!config.trustedProxies.includes(parts[i])) return parts[i];
			}
		}
	}
	return peer;
}

/**
 * セッションクッキーをレスポンスにセットする
 * maxAge=0 を指定するとクッキーを削除（ログアウト）する
 */
export function setSessionCookie(
	res: ServerResponse,
	req: IncomingMessage,
	token: string,
	maxAge?: number,
): void {
	// Cookieのハードニングはリクエスト毎の推定ではなくデプロイ設定で決める。
	// BASE_URL が https の本番では、当該リクエストの proto 検出に関わらず常に Secure + __Host- を付与する。
	const isHttps = isHttpsDeployment() || checkHttps(req);
	const name = isHttps ? "__Host-yuuka-session" : "yuuka-session";
	const secure = isHttps ? "; Secure" : "";
	const expires =
		maxAge !== undefined
			? `; Max-Age=${maxAge}`
			: `; Max-Age=${config.sessionTtlDays * 24 * 60 * 60}`;
	res.setHeader(
		"Set-Cookie",
		`${name}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax${expires}`,
	);
}

/**
 * セッションの妥当性をチェックし、セッションユーザーを返す（§5.4.2）
 * Redis保存・7日間スライディングウィンドウ（getSession がTTLを自動延長する）
 */
export async function getSessionUser(
	req: IncomingMessage,
): Promise<SessionUser | null> {
	const token = getSessionToken(req);
	if (!token) return null;
	try {
		return await getSession(token);
	} catch {
		return null;
	}
}
