import {
	approveDeviceCode,
	createDeviceCode,
	exchangeDeviceToken,
} from "../../services/desktopAuthService.js";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ─── デスクトップクライアント: OAuth デバイスフロー（RFC 8628 型） ──────────────
// 設計: docs/design/desktop_client/backend_api.md §1。
// - /code・/token は auth:"none"（device_code 自体が capability）。
// - /approve は auth:"user"（ログイン済み本人の操作。CSRF は既存 Origin チェックが担保）。

export const deviceAuthRoutes: RouteDef[] = [
	{
		// §1.1: アプリ起動時、未ログインで呼ぶ。デバイスコードとユーザーコードを発行する。
		method: "POST",
		path: "/api/auth/device/code",
		auth: "none",
		async handler(ctx) {
			const deviceName =
				typeof ctx.body.device_name === "string"
					? ctx.body.device_name.slice(0, 200)
					: undefined;
			const result = await createDeviceCode(deviceName);
			sendJson(ctx.res, 200, result);
		},
	},
	{
		// §1.2: ブラウザ（ログイン済み本人）から /device 経由で user_code を承認する。
		method: "POST",
		path: "/api/auth/device/approve",
		auth: "user",
		async handler(ctx) {
			const userCode =
				typeof ctx.body.user_code === "string" ? ctx.body.user_code : "";
			if (!userCode.trim()) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "ユーザーコードが必要です。",
				});
			}
			const result = await approveDeviceCode(userCode, ctx.user!.discordId);
			if (!result.ok) {
				const code = result.reason === "expired" ? 410 : 404;
				return sendJson(ctx.res, code, {
					success: false,
					message:
						result.reason === "expired"
							? "このコードは期限切れです。アプリで再度お試しください。"
							: "コードが見つかりません。入力を確認してください。",
				});
			}
			sendJson(ctx.res, 200, {
				success: true,
				device_name: result.deviceName,
			});
		},
	},
	{
		// §1.3: アプリが interval 秒ごとにポーリングし device_code をトークンへ交換する。
		method: "POST",
		path: "/api/auth/device/token",
		auth: "none",
		async handler(ctx) {
			const deviceCode =
				typeof ctx.body.device_code === "string" ? ctx.body.device_code : "";
			if (!deviceCode) {
				return sendJson(ctx.res, 400, { error: "invalid_request" });
			}
			const result = await exchangeDeviceToken(deviceCode);
			switch (result.status) {
				case "authorization_pending":
					return sendJson(ctx.res, 200, { error: "authorization_pending" });
				case "slow_down":
					return sendJson(ctx.res, 200, { error: "slow_down" });
				case "expired_token":
					return sendJson(ctx.res, 410, { error: "expired_token" });
				case "approved":
					return sendJson(ctx.res, 200, {
						access_token: result.access_token,
						token_type: "Bearer",
						expires_in: result.expires_in,
						user: result.user,
					});
			}
		},
	},
];
