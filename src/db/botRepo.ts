import { getDb } from "./database.js";

// ─── Botインスタンス（§5.1: Discord APIトークン単位で1インスタンス） ──────────

export interface BotRecord {
	id: string;
	user_id: string; // Bot作成者（オーナー）
	name: string;
	discord_token_encrypted: string | null;
	discord_token_iv: string | null;
	discord_token_tag: string | null;
	recommended_persona_id: number | null;
	discord_username: string | null;
	discord_avatar_url: string | null;
	/** Discord側のbot user ID（= application/client ID）。招待リンク・プロフィールURLの生成に使用 */
	discord_application_id: string | null;
	suspended: number;
	/** オーナーによる手動停止フラグ（再起動後も停止状態を維持。1=停止 / 0=自動起動）。管理者処分の suspended とは独立。 */
	stopped: number;
	/** Bot属性: ケーパビリティのJSON配列（bot_attributes_requirements.md §3） */
	capabilities: string;
	/** Bot単位ペルソナ（汎用モード用。要件 §4.4） */
	persona_id: number | null;
	/** 有効モジュールIDのJSON配列。NULL = 全モジュール有効（function_modularization.md §4.1） */
	enabled_modules: string | null;
	/** Bot専用Gemini APIキー（システム鍵で暗号化。要件 §4.3.3） */
	gemini_api_key_encrypted: string | null;
	gemini_api_key_iv: string | null;
	gemini_api_key_tag: string | null;
	created_at: string;
	updated_at: string;
}

export interface BotDiscordConfig {
	tokenEncrypted: string | null;
	tokenIv: string | null;
	tokenTag: string | null;
}

export interface BotShareRecord {
	id: number;
	bot_id: string;
	owner_id: string;
	shared_user_id: string;
	status: "pending" | "active" | "revoked";
	created_at: string;
	updated_at: string;
}

/**
 * 新しいBotインスタンスを作成する
 */
export function createBot(
	botId: string,
	userId: string,
	name: string,
): BotRecord {
	const db = getDb();
	db.prepare(`INSERT INTO bots (id, user_id, name) VALUES (?, ?, ?)`).run(
		botId,
		userId,
		name,
	);
	return getBotById(botId)!;
}

export function getBotById(botId: string): BotRecord | undefined {
	const db = getDb();
	return db.prepare("SELECT * FROM bots WHERE id = ?").get(botId) as
		| BotRecord
		| undefined;
}

/**
 * ユーザーが利用可能なBot一覧を取得する
 * （自身がオーナーのBot + システムデフォルトBot + 共有が有効(active)なBot）
 */
export function listBotsForUser(userId: string): BotRecord[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT DISTINCT b.* FROM bots b
       LEFT JOIN bot_shares s ON s.bot_id = b.id AND s.shared_user_id = ? AND s.status = 'active'
       WHERE b.user_id = ? OR b.id = 'system_default' OR s.id IS NOT NULL
       ORDER BY b.created_at ASC`,
		)
		.all(userId, userId) as BotRecord[];
}

/**
 * 統合管理画面用: ユーザーが「所有する」Bot のみ（共有・system_default は含めない）。
 * 起動停止やリソース許可付与の対象は所有Botに限る。
 */
export function listBotsOwnedBy(userId: string): BotRecord[] {
	return getDb()
		.prepare("SELECT * FROM bots WHERE user_id = ? ORDER BY created_at ASC")
		.all(userId) as BotRecord[];
}

/**
 * ユーザーが指定Botへアクセス可能か検証する（§5.5）
 */
export function hasBotAccess(userId: string, botId: string): boolean {
	if (botId === "system_default") return true;
	const db = getDb();
	const row = db
		.prepare(
			`SELECT 1 FROM bots b
       LEFT JOIN bot_shares s ON s.bot_id = b.id AND s.shared_user_id = ? AND s.status = 'active'
       WHERE b.id = ? AND (b.user_id = ? OR s.id IS NOT NULL)`,
		)
		.get(userId, botId, userId);
	return !!row;
}

export function listAllBotIds(): string[] {
	const db = getDb();
	const rows = db.prepare("SELECT id FROM bots").all() as { id: string }[];
	return rows.map((r) => r.id);
}

export function listAllBots(): BotRecord[] {
	const db = getDb();
	return db
		.prepare("SELECT * FROM bots ORDER BY created_at ASC")
		.all() as BotRecord[];
}

export function deleteBot(botId: string): boolean {
	const db = getDb();
	const result = db.prepare("DELETE FROM bots WHERE id = ?").run(botId);
	return result.changes > 0;
}

/**
 * BotのDiscordトークン（暗号化済み）を更新する
 * §4.3.1: トークンの設定・変更はBotオーナー（または管理者）のみが行えること（認可は呼び出し側で検証）
 */
export function updateBotDiscordToken(
	botId: string,
	tokenEncrypted: string | null,
	tokenIv: string | null,
	tokenTag: string | null,
): boolean {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE bots SET discord_token_encrypted = ?, discord_token_iv = ?, discord_token_tag = ?,
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
		)
		.run(tokenEncrypted, tokenIv, tokenTag, botId);
	return result.changes > 0;
}

export function getBotDiscordConfig(botId: string): BotDiscordConfig | null {
	const bot = getBotById(botId);
	if (!bot) return null;
	return {
		tokenEncrypted: bot.discord_token_encrypted,
		tokenIv: bot.discord_token_iv,
		tokenTag: bot.discord_token_tag,
	};
}

/** Discord側から取得したプロフィール（名前・アバター・application ID）をDBへ同期する（§4.3.2） */
export function updateBotDiscordProfile(
	botId: string,
	discordUsername?: string,
	avatarUrl?: string,
	applicationId?: string,
): boolean {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE bots SET discord_username = COALESCE(?, discord_username),
       discord_avatar_url = COALESCE(?, discord_avatar_url),
       discord_application_id = COALESCE(?, discord_application_id),
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
		)
		.run(
			discordUsername ?? null,
			avatarUrl ?? null,
			applicationId ?? null,
			botId,
		);
	return result.changes > 0;
}

export function updateBotProfile(
	botId: string,
	name: string,
	avatarUrl?: string,
): boolean {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE bots SET name = ?, discord_avatar_url = COALESCE(?, discord_avatar_url),
       updated_at = datetime('now', 'localtime') WHERE id = ?`,
		)
		.run(name, avatarUrl ?? null, botId);
	return result.changes > 0;
}

export function suspendBot(botId: string): boolean {
	const db = getDb();
	return (
		db.prepare("UPDATE bots SET suspended = 1 WHERE id = ?").run(botId)
			.changes > 0
	);
}

export function unsuspendBot(botId: string): boolean {
	const db = getDb();
	return (
		db.prepare("UPDATE bots SET suspended = 0 WHERE id = ?").run(botId)
			.changes > 0
	);
}

export function isBotSuspended(botId: string): boolean {
	const bot = getBotById(botId);
	return !!bot && bot.suspended === 1;
}

/**
 * オーナーによる起動/停止の希望状態を永続化する。
 * stopped=1 にすると次回ブート時の自動起動対象から外れ、再起動後も停止が維持される。
 * （管理者処分の suspend/unsuspend とは独立したフラグ）
 */
export function setBotStopped(botId: string, stopped: boolean): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bots SET stopped = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
			)
			.run(stopped ? 1 : 0, botId).changes > 0
	);
}

export function isBotStopped(botId: string): boolean {
	const bot = getBotById(botId);
	return !!bot && bot.stopped === 1;
}

/**
 * Bot単位ペルソナを設定する（要件 §4.4: owner所有 or 公開ペルソナのみ。検証は呼び出し側）
 */
export function setBotPersona(
	botId: string,
	personaId: number | null,
): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bots SET persona_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
			)
			.run(personaId, botId).changes > 0
	);
}

/**
 * 有効モジュール選択を更新する（function_modularization.md §4.1）。
 * null を渡すと全モジュール有効（後方互換）。認可・キャッシュ無効化は呼び出し側で行う。
 */
export function setBotEnabledModules(
	botId: string,
	enabledModules: string[] | null,
): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bots SET enabled_modules = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
			)
			.run(enabledModules == null ? null : JSON.stringify(enabledModules), botId)
			.changes > 0
	);
}

/**
 * Bot専用のGemini APIキー（暗号化済み）を更新する（要件 §4.3.3。認可は呼び出し側で検証）
 */
export function updateBotGeminiKey(
	botId: string,
	encrypted: string | null,
	iv: string | null,
	tag: string | null,
): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bots SET gemini_api_key_encrypted = ?, gemini_api_key_iv = ?, gemini_api_key_tag = ?,
         updated_at = datetime('now', 'localtime') WHERE id = ?`,
			)
			.run(encrypted, iv, tag, botId).changes > 0
	);
}

/**
 * 推奨ペルソナを設定する（§5.2.1: is_public = true のペルソナのみ。検証は呼び出し側）
 */
export function setRecommendedPersona(
	botId: string,
	personaId: number | null,
): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bots SET recommended_persona_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
			)
			.run(personaId, botId).changes > 0
	);
}

// ─── Bot共有（§5.2） ─────────────────────────────────────────────────────────

/** 共有招待を作成する（既存の revoked 招待は pending として再利用） */
export function createShareInvite(
	botId: string,
	ownerId: string,
	sharedUserId: string,
): BotShareRecord {
	const db = getDb();
	db.prepare(
		`INSERT INTO bot_shares (bot_id, owner_id, shared_user_id, status) VALUES (?, ?, ?, 'pending')
     ON CONFLICT(bot_id, shared_user_id)
     DO UPDATE SET status = 'pending', updated_at = datetime('now', 'localtime')`,
	).run(botId, ownerId, sharedUserId);
	return db
		.prepare("SELECT * FROM bot_shares WHERE bot_id = ? AND shared_user_id = ?")
		.get(botId, sharedUserId) as BotShareRecord;
}

/** 招待を承認してアクセスを有効化する（§5.2.2） */
export function acceptShareInvite(
	botId: string,
	sharedUserId: string,
): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bot_shares SET status = 'active', updated_at = datetime('now', 'localtime')
         WHERE bot_id = ? AND shared_user_id = ? AND status = 'pending'`,
			)
			.run(botId, sharedUserId).changes > 0
	);
}

/** 共有アクセスを取り消す（Bot作成者のみ。認可は呼び出し側で検証） */
export function revokeShare(botId: string, sharedUserId: string): boolean {
	const db = getDb();
	return (
		db
			.prepare(
				`UPDATE bot_shares SET status = 'revoked', updated_at = datetime('now', 'localtime')
         WHERE bot_id = ? AND shared_user_id = ?`,
			)
			.run(botId, sharedUserId).changes > 0
	);
}

export function listSharesForBot(botId: string): BotShareRecord[] {
	const db = getDb();
	return db
		.prepare(
			"SELECT * FROM bot_shares WHERE bot_id = ? ORDER BY created_at ASC",
		)
		.all(botId) as BotShareRecord[];
}

/** 指定ユーザー宛の共有招待一覧（承認待ち画面・DM通知用） */
export function listShareInvitesForUser(
	userId: string,
	status?: "pending" | "active" | "revoked",
): BotShareRecord[] {
	const db = getDb();
	if (status) {
		return db
			.prepare(
				"SELECT * FROM bot_shares WHERE shared_user_id = ? AND status = ? ORDER BY created_at DESC",
			)
			.all(userId, status) as BotShareRecord[];
	}
	return db
		.prepare(
			"SELECT * FROM bot_shares WHERE shared_user_id = ? ORDER BY created_at DESC",
		)
		.all(userId) as BotShareRecord[];
}

export function getShareById(shareId: number): BotShareRecord | undefined {
	const db = getDb();
	return db.prepare("SELECT * FROM bot_shares WHERE id = ?").get(shareId) as
		| BotShareRecord
		| undefined;
}
