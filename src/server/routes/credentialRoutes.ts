import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import * as secretService from "../../services/secretService.js";
import { hasBotAccess, listBotsOwnedBy } from "../../db/botRepo.js";
import {
	listCredentialNamesForBot,
	grantCredentialToBot,
	deleteAllGrantsForCredential,
} from "../../db/credentialAccessRepo.js";

// ─── パスワードマネージャ HTTPルート（§6: ユーザー鍵暗号化） ──────────────────
// 監査ログは secretService 層で記録される（二重記録しない）。

/**
 * 登録した認証情報を「owner本人の全Bot＋共有秘書(system_default)」へ利用許可する。
 * v5の初期バックフィル（既存credを owner所有Bot + system_default へ付与）および会話経由の
 * addCredential（応対中Botへ即時付与）と挙動を揃え、Web UIから登録した認証情報も
 * 登録した時点でBot側（ランタイムの isCredentialGrantedToBot ゲート）から認識されるようにする。
 * 付与はすべて owner本人のスコープ＝クロステナント露出は発生しない（system_default は
 * 「発話者=owner の会話」でのみ当該許可が効く）。serviceName は credentials と同じ正規化前提。
 */
function grantCredentialToOwnerBots(
	userId: string,
	normalizedServiceName: string,
): void {
	const botIds = new Set<string>(listBotsOwnedBy(userId).map((b) => b.id));
	botIds.add("system_default");
	for (const botId of botIds)
		grantCredentialToBot(botId, userId, normalizedServiceName);
}

export const credentialRoutes: RouteDef[] = [
	{
		method: "GET",
		path: "/api/credentials",
		auth: "user",
		async handler(ctx) {
			// Bot個別の「利用可能なAI認証情報」欄向け。認証情報は (owner=user) 所有のまま、
			// 当該Botへ利用を許可済み（bot_credential_access）のものだけ返す（ランタイムの
			// isCredentialGrantedToBot ゲートと一致させる）。未許可の認証情報は表示しない。
			const userId = ctx.user!.discordId;
			const rawBotId =
				(typeof ctx.body.botId === "string" && ctx.body.botId) ||
				ctx.url.searchParams.get("botId") ||
				"";
			// アクセス権の無いBotは system_default にフォールバック（他人のBotのスコープで覗かせない）。
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const grantedSet = new Set(listCredentialNamesForBot(botId, userId));
			const list = secretService
				.listCredentialServices(userId)
				.filter((c) => grantedSet.has(c.service_name));
			sendJson(ctx.res, 200, { success: true, credentials: list });
		},
	},
	{
		method: "POST",
		path: "/api/credentials/register",
		auth: "user",
		async handler(ctx) {
			const { serviceName, username, password, url } = ctx.body as Record<
				string,
				string
			>;
			if (!serviceName || !username || !password) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "サービス名、ユーザー名、およびパスワードは必須です。",
				});
			}
			try {
				const userId = ctx.user!.discordId;
				secretService.registerCredential(
					userId,
					serviceName,
					username,
					password,
					url || undefined,
				);
				// 登録＝利用可能を保証する（登録直後の /api/credentials 一覧やランタイムから認識される）。
				// 正規化は registerCredential と同一（trim + toLowerCase）。grantは冪等(INSERT OR IGNORE)。
				grantCredentialToOwnerBots(userId, serviceName.trim().toLowerCase());
				sendJson(ctx.res, 200, {
					success: true,
					message: "資格情報を正常に登録しました。",
				});
			} catch (err) {
				sendJson(ctx.res, 400, {
					success: false,
					message: (err as Error).message || "資格情報の登録に失敗しました。",
				});
			}
		},
	},
	{
		method: "POST",
		path: "/api/credentials/delete",
		auth: "user",
		async handler(ctx) {
			const { serviceName } = ctx.body as Record<string, string>;
			if (!serviceName) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "サービス名は必須です。",
				});
			}
			const userId = ctx.user!.discordId;
			const success = secretService.deleteCredential(userId, serviceName);
			// 削除に伴い全Botの利用許可も掃除する（LLM側 deleteCredential と挙動を揃える。
			// credentials への DB FK が無いため明示的に。残すと同名再登録時に意図せず許可が復活する）。
			if (success)
				deleteAllGrantsForCredential(userId, serviceName.trim().toLowerCase());
			sendJson(ctx.res, 200, { success });
		},
	},
];
