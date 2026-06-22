import { getDb } from "./database.js";

// ─── 認証情報の利用許可（bot_credential_access） ─────────────────────────────
// v5: credentials は (owner_id=user_id, service_name) 所有のまま、使わせる Bot を許可リストで選ぶ。
// credentials の PK が複合のため DB の FK は張らず（owner_id→users はFKあり）、削除時の掃除は
// deleteAllGrantsForCredential() をリポジトリ層で呼ぶ。service_name は credentials と同じ正規化前提。

/** Botに当該認証情報の利用を許可する（冪等）。 */
export function grantCredentialToBot(
	botId: string,
	ownerId: string,
	serviceName: string,
): void {
	getDb()
		.prepare(
			"INSERT OR IGNORE INTO bot_credential_access (bot_id, owner_id, service_name) VALUES (?, ?, ?)",
		)
		.run(botId, ownerId, serviceName);
}

/** Botから当該認証情報の利用許可を取り消す。 */
export function revokeCredentialFromBot(
	botId: string,
	ownerId: string,
	serviceName: string,
): void {
	getDb()
		.prepare(
			"DELETE FROM bot_credential_access WHERE bot_id = ? AND owner_id = ? AND service_name = ?",
		)
		.run(botId, ownerId, serviceName);
}

/** 当該認証情報の利用を許可されている Bot ID 一覧。 */
export function listBotIdsForCredential(
	ownerId: string,
	serviceName: string,
): string[] {
	return (
		getDb()
			.prepare(
				"SELECT bot_id FROM bot_credential_access WHERE owner_id = ? AND service_name = ?",
			)
			.all(ownerId, serviceName) as { bot_id: string }[]
	).map((r) => r.bot_id);
}

/** Botが利用を許可されている認証情報名一覧（owner所有分）。 */
export function listCredentialNamesForBot(
	botId: string,
	ownerId: string,
): string[] {
	return (
		getDb()
			.prepare(
				"SELECT service_name FROM bot_credential_access WHERE bot_id = ? AND owner_id = ?",
			)
			.all(botId, ownerId) as { service_name: string }[]
	).map((r) => r.service_name);
}

/** Botが当該認証情報の利用を許可されているか（ランタイムのゲート）。 */
export function isCredentialGrantedToBot(
	botId: string,
	ownerId: string,
	serviceName: string,
): boolean {
	return !!getDb()
		.prepare(
			"SELECT 1 FROM bot_credential_access WHERE bot_id = ? AND owner_id = ? AND service_name = ? LIMIT 1",
		)
		.get(botId, ownerId, serviceName);
}

/** 認証情報削除時に、その許可を全て掃除する（credentials への DB FK が無いため明示的に呼ぶ）。 */
export function deleteAllGrantsForCredential(
	ownerId: string,
	serviceName: string,
): void {
	getDb()
		.prepare(
			"DELETE FROM bot_credential_access WHERE owner_id = ? AND service_name = ?",
		)
		.run(ownerId, serviceName);
}
