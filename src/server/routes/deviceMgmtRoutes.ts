import { addAuditLog } from "../../db/auditRepo.js";
import {
	listDesktopTokensForUser,
	revokeDesktopToken,
} from "../../db/desktopTokenRepo.js";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { sha256Hex } from "../../utils/crypto.js";
import { getBearerToken } from "../httpHelpers.js";

// ─── デスクトップクライアント: 端末（desktop トークン）管理 ─────────────────────
// 設計: docs/design/desktop_client/backend_api.md §4。管理は Web ダッシュボードに集約する。
// auth:"user" のため Cookie セッション・Bearer のいずれでも本人として操作できる。

export const deviceMgmtRoutes: RouteDef[] = [
	{
		// 接続端末の一覧（トークン本体は返さない）。current? は呼び出し元自身の端末かどうか。
		method: "GET",
		path: "/api/devices",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			// Bearer 認証時のみ「現在の端末」を判定できる（Cookie 経路では undefined）。
			const bearer = getBearerToken(ctx.req);
			const currentHash = bearer ? sha256Hex(bearer) : null;
			const devices = listDesktopTokensForUser(userId).map((t) => ({
				id: t.id,
				device_name: t.device_name,
				created_at: t.created_at,
				last_used_at: t.last_used_at,
				current: currentHash ? t.token_hash === currentHash : false,
			}));
			sendJson(ctx.res, 200, { success: true, devices });
		},
	},
	{
		// 端末単位の失効（本人スコープ）。失効後、当該端末の WS/REST は次回 401。
		method: "POST",
		path: "/api/devices/revoke",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const id =
				typeof ctx.body.id === "number"
					? ctx.body.id
					: Number.parseInt(String(ctx.body.id ?? ""), 10);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "端末IDが不正です。",
				});
			}
			const ok = revokeDesktopToken(id, userId);
			if (!ok) {
				return sendJson(ctx.res, 404, {
					success: false,
					message: "対象の端末が見つかりません。",
				});
			}
			addAuditLog(userId, "desktop.token_revoke", String(id));
			sendJson(ctx.res, 200, { success: true });
		},
	},
];
