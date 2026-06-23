import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { generateUserSalt } from "../utils/crypto.js";
import { getDb } from "./database.js";

/**
 * users テーブル（スキーマv2）のリポジトリ（仕様§5.3, §5.4, §4.2）。
 * - パスワードは bcrypt (cost 12) でハッシュ化する（旧scryptは廃止）。
 * - salt はユーザー鍵導出（Argon2id, crypto.ts）専用。パスワード変更時も変更しない。
 * - 全クエリは discord_id（DiscordユーザーID）でスコープする。
 */

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export interface UserRecord {
	discord_id: string;
	username: string;
	password_hash: string;
	salt: string;
	role: string; // 'user' | 'admin'
	gemini_api_key_encrypted: string | null;
	gemini_api_key_iv: string | null;
	gemini_api_key_tag: string | null;
	gemini_model: string;
	google_refresh_token_encrypted: string | null;
	google_refresh_token_iv: string | null;
	google_refresh_token_tag: string | null;
	google_calendar_id: string | null;
	google_calendars: string; // JSON string[]
	rich_reply_enabled: number;
	remind_default_minutes: number;
	notify_target_type: string; // 'dm' | 'channel'
	notify_target_id: string | null;
	active_persona_id: number | null;
	timezone: string;
	backup_enabled: number;
	backup_interval_hours: number;
	backup_generations: number;
	backup_folder_id: string | null;
	backup_last_run_at: string | null;
	created_at: string;
	updated_at: string;
}

/** Admin管理画面用ユーザービュー（パスワードハッシュ・salt・暗号化済み秘密値を除外） */
export interface AdminUserView {
	discord_id: string;
	username: string;
	role: string;
	created_at: string;
	updated_at: string;
}

export interface UserGeminiConfig {
	apiKeyEncrypted: string | null;
	apiKeyIv: string | null;
	apiKeyTag: string | null;
	model: string;
}

export interface UserGoogleConfig {
	refreshTokenEncrypted: string;
	refreshTokenIv: string;
	refreshTokenTag: string;
	calendarId: string | null;
	calendars: string[];
}

export interface UserBackupConfig {
	enabled: boolean;
	intervalHours: number;
	generations: number;
	folderId: string | null;
	lastRunAt: string | null;
}

export interface UserSettingsUpdate {
	richReplyEnabled?: boolean;
	remindDefaultMinutes?: number;
	notifyTargetType?: "dm" | "channel";
	notifyTargetId?: string | null;
	timezone?: string;
	/** @deprecated v8: 秘書ペルソナは bot_active_personas（Bot単位）へ移行。レガシー列のみ更新する。 */
	activePersonaId?: number | null;
}

// ─── パスワードハッシュ（bcrypt cost 12, 仕様§5.4.3） ──────────────────────

const BCRYPT_COST = 12;

/**
 * パスワードを bcrypt（コストファクター12）でハッシュ化する
 */
export function hashPassword(password: string): string {
	return bcrypt.hashSync(password, BCRYPT_COST);
}

/**
 * パスワードと bcrypt ハッシュを照合する（タイミング攻撃耐性あり）
 */
export function verifyPassword(password: string, storedHash: string): boolean {
	try {
		return bcrypt.compareSync(password, storedHash);
	} catch {
		// 不正なハッシュ形式（旧scrypt形式等）は照合失敗として扱う
		return false;
	}
}

// タイミング均一化用のダミーハッシュ（BCRYPT_COST と同コストで生成済み）。
// ユーザーが存在しない場合でも同等の bcrypt 比較時間を消費し、応答時間差による
// アカウント列挙（存在判定）を防ぐ。コストを変更したらこの値も再生成すること。
const DUMMY_PASSWORD_HASH =
	"$2b$12$tvcUPxX5xmqpVZCS6aSDQe7WKkrXvMd8batVtwbJFI1uJ42EzpGlG";

/**
 * ユーザー有無に依らず一定の bcrypt 比較時間を消費したうえでパスワードを照合する。
 * storedHash が null（＝ユーザー不在）でもダミーハッシュとの比較を行い、必ず false を返す。
 * ログイン処理でのタイミングオラクル（アカウント列挙）対策に用いる。
 */
export function verifyPasswordConstantTime(
	password: string,
	storedHash: string | null | undefined,
): boolean {
	if (!storedHash) {
		// ユーザー不在でもダミー比較で時間を消費し、存在判定を防ぐ
		verifyPassword(password, DUMMY_PASSWORD_HASH);
		return false;
	}
	return verifyPassword(password, storedHash);
}

// ─── ユーザーCRUD ────────────────────────────────────────────────────────────

/**
 * ユーザーを新規登録する（仕様§5.4.1）。
 * - salt はユーザー鍵導出（パスワードマネージャ）用に CSPRNG で自動生成する。
 * - 最初の登録ユーザー、または config.adminDiscordIds に含まれる場合は role='admin'。
 */
export function createUser(
	discordId: string,
	username: string,
	password: string,
): UserRecord {
	const db = getDb();
	const passwordHash = hashPassword(password);
	const salt = generateUserSalt();

	const runTx = db.transaction(() => {
		const countRow = db
			.prepare("SELECT COUNT(*) as count FROM users")
			.get() as { count: number };
		const isFirstUser = countRow.count === 0;
		const role =
			isFirstUser || config.adminDiscordIds.includes(discordId)
				? "admin"
				: "user";

		db.prepare(`
      INSERT INTO users (discord_id, username, password_hash, salt, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(discordId, username, passwordHash, salt, role);
	});

	runTx();
	return getUserByDiscordId(discordId)!;
}

/**
 * Discord IDでユーザーを取得する
 */
export function getUserByDiscordId(discordId: string): UserRecord | undefined {
	const db = getDb();
	return db
		.prepare("SELECT * FROM users WHERE discord_id = ?")
		.get(discordId) as UserRecord | undefined;
}

/**
 * ユーザーが登録済みかどうか高速に判定する（Botのメッセージフィルタ用）
 */
export function isRegisteredUser(discordId: string): boolean {
	const db = getDb();
	const row = db
		.prepare("SELECT 1 FROM users WHERE discord_id = ? LIMIT 1")
		.get(discordId);
	return !!row;
}

/**
 * 登録済みユーザーID一覧を取得する
 * （cron系サービスの全ユーザー走査用。データ分離原則の例外として許容）
 */
export function listAllUserIds(): string[] {
	const db = getDb();
	const rows = db
		.prepare("SELECT discord_id FROM users ORDER BY created_at ASC")
		.all() as { discord_id: string }[];
	return rows.map((r) => r.discord_id);
}

/**
 * ユーザーネームを変更する
 */
export function updateUsername(
	discordId: string,
	newUsername: string,
): boolean {
	const db = getDb();
	const result = db
		.prepare(`
    UPDATE users SET username = ?, updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `)
		.run(newUsername, discordId);
	return result.changes > 0;
}

/**
 * パスワードを変更する（bcryptで再ハッシュ）。
 * 注意: salt はユーザー鍵導出（credentials の暗号化）用であり、
 * 変更すると保存済みパスワードが復号不能になるため絶対に変更しない。
 * セッション全失効（sessionService.destroyAllSessionsForUser）は呼び出し側で行うこと。
 */
export function updatePassword(
	discordId: string,
	newPassword: string,
): boolean {
	const db = getDb();
	const passwordHash = hashPassword(newPassword);
	const result = db
		.prepare(`
    UPDATE users SET password_hash = ?, updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `)
		.run(passwordHash, discordId);
	return result.changes > 0;
}

/**
 * ユーザーを削除する（関連データは外部キー ON DELETE CASCADE で削除される）
 */
export function deleteUser(discordId: string): boolean {
	const db = getDb();
	const result = db
		.prepare("DELETE FROM users WHERE discord_id = ?")
		.run(discordId);
	return result.changes > 0;
}

// ─── Admin RBAC（§5.3） ──────────────────────────────────────────────────────

/**
 * 全ユーザー一覧を取得する（Admin管理画面用。パスワードハッシュ・秘密値は除外）
 */
export function listAllUsers(): AdminUserView[] {
	const db = getDb();
	return db
		.prepare(
			"SELECT discord_id, username, role, created_at, updated_at FROM users ORDER BY created_at ASC",
		)
		.all() as AdminUserView[];
}

/**
 * ユーザーのロールを変更する（Admin専用操作。監査ログは呼び出し側で記録）
 */
export function updateUserRole(discordId: string, role: string): boolean {
	if (role !== "user" && role !== "admin") return false;
	const db = getDb();
	const result = db
		.prepare(
			"UPDATE users SET role = ?, updated_at = datetime('now', 'localtime') WHERE discord_id = ?",
		)
		.run(role, discordId);
	return result.changes > 0;
}

/**
 * Admin ロールのユーザー数を数える（最後の管理者の削除/降格を防ぐためのガード用）
 */
export function countAdmins(): number {
	const db = getDb();
	const row = db
		.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")
		.get() as { count: number };
	return row.count;
}

/**
 * ユーザーが Admin かどうか判定する
 */
export function isAdmin(discordId: string): boolean {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT 1 FROM users WHERE discord_id = ? AND role = 'admin' LIMIT 1",
		)
		.get(discordId);
	return !!row;
}

// ─── Gemini API 設定（§4.2: ユーザー毎・共有不可） ──────────────────────────

/**
 * ユーザーのGemini設定を取得する（復号は呼び出し側 llmClient が行う）
 */
export function getUserGeminiConfig(
	discordId: string,
): UserGeminiConfig | null {
	const db = getDb();
	const row = db
		.prepare(`
    SELECT gemini_api_key_encrypted, gemini_api_key_iv, gemini_api_key_tag, gemini_model
    FROM users WHERE discord_id = ?
  `)
		.get(discordId) as
		| {
				gemini_api_key_encrypted: string | null;
				gemini_api_key_iv: string | null;
				gemini_api_key_tag: string | null;
				gemini_model: string | null;
		  }
		| undefined;

	if (!row) return null;
	return {
		apiKeyEncrypted: row.gemini_api_key_encrypted,
		apiKeyIv: row.gemini_api_key_iv,
		apiKeyTag: row.gemini_api_key_tag,
		model: row.gemini_model || "gemini-3.1-flash-lite",
	};
}

/**
 * ユーザーのGemini設定を更新する（APIキーは暗号化済みの値を渡すこと）
 */
export function updateUserGeminiSettings(
	discordId: string,
	apiKeyEncrypted: string | null,
	apiKeyIv: string | null,
	apiKeyTag: string | null,
	model: string,
): boolean {
	const db = getDb();
	const result = db
		.prepare(`
    UPDATE users SET
      gemini_api_key_encrypted = ?,
      gemini_api_key_iv = ?,
      gemini_api_key_tag = ?,
      gemini_model = ?,
      updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `)
		.run(apiKeyEncrypted, apiKeyIv, apiKeyTag, model, discordId);
	return result.changes > 0;
}

// ─── Google OAuth 設定（§3.2.2, §8: ユーザー毎） ─────────────────────────────

/**
 * ユーザーのGoogle OAuth設定を取得する。
 * リフレッシュトークン未設定（=Google未連携）の場合は null を返す。
 * トークンの復号は呼び出し側（decryptText）、OAuthクライアントは config のシステム共通
 * （googleClientId / googleClientSecret）を使用する。
 */
export function getUserGoogleConfig(
	discordId: string,
): UserGoogleConfig | null {
	const db = getDb();
	const row = db
		.prepare(`
    SELECT google_refresh_token_encrypted, google_refresh_token_iv, google_refresh_token_tag,
           google_calendar_id, google_calendars
    FROM users WHERE discord_id = ?
  `)
		.get(discordId) as
		| {
				google_refresh_token_encrypted: string | null;
				google_refresh_token_iv: string | null;
				google_refresh_token_tag: string | null;
				google_calendar_id: string | null;
				google_calendars: string | null;
		  }
		| undefined;

	if (
		!row ||
		!row.google_refresh_token_encrypted ||
		!row.google_refresh_token_iv ||
		!row.google_refresh_token_tag
	) {
		return null;
	}

	let calendars: string[] = [];
	try {
		const parsed = JSON.parse(row.google_calendars || "[]");
		if (Array.isArray(parsed))
			calendars = parsed.filter((c): c is string => typeof c === "string");
	} catch {
		// 不正なJSONは空リスト扱い
	}

	return {
		refreshTokenEncrypted: row.google_refresh_token_encrypted,
		refreshTokenIv: row.google_refresh_token_iv,
		refreshTokenTag: row.google_refresh_token_tag,
		calendarId: row.google_calendar_id,
		calendars,
	};
}

/**
 * ユーザーのGoogle OAuth設定を部分更新する（トークンは暗号化済みの値を渡すこと）。
 * refreshTokenEncrypted 等に null を渡すと連携解除になる。
 */
export function updateUserGoogleSettings(
	discordId: string,
	settings: {
		refreshTokenEncrypted?: string | null;
		refreshTokenIv?: string | null;
		refreshTokenTag?: string | null;
		calendarId?: string | null;
		calendars?: string[];
	},
): boolean {
	const sets: string[] = [];
	const values: (string | null)[] = [];

	if (settings.refreshTokenEncrypted !== undefined) {
		sets.push("google_refresh_token_encrypted = ?");
		values.push(settings.refreshTokenEncrypted);
	}
	if (settings.refreshTokenIv !== undefined) {
		sets.push("google_refresh_token_iv = ?");
		values.push(settings.refreshTokenIv);
	}
	if (settings.refreshTokenTag !== undefined) {
		sets.push("google_refresh_token_tag = ?");
		values.push(settings.refreshTokenTag);
	}
	if (settings.calendarId !== undefined) {
		sets.push("google_calendar_id = ?");
		values.push(settings.calendarId);
	}
	if (settings.calendars !== undefined) {
		sets.push("google_calendars = ?");
		values.push(JSON.stringify(settings.calendars));
	}
	if (sets.length === 0) return false;

	const db = getDb();
	const result = db
		.prepare(
			`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now', 'localtime') WHERE discord_id = ?`,
		)
		.run(...values, discordId);
	return result.changes > 0;
}

// ─── ユーザー設定（§3.0.5, §3.3.2 等） ──────────────────────────────────────

/**
 * 通知の既定送信先を取得する（notifier.ts が使用）。
 * ユーザー未登録の場合は null。'channel' 設定だが target_id が無い場合は DM へフォールバック。
 */
export function getUserNotifyTarget(
	discordId: string,
): { type: "dm" | "channel"; id?: string } | null {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT notify_target_type, notify_target_id FROM users WHERE discord_id = ?",
		)
		.get(discordId) as
		| { notify_target_type: string; notify_target_id: string | null }
		| undefined;

	if (!row) return null;
	if (row.notify_target_type === "channel" && row.notify_target_id) {
		return { type: "channel", id: row.notify_target_id };
	}
	return { type: "dm" };
}

/**
 * ユーザー鍵導出用ソルト（hex）を取得する（パスワードマネージャの暗号化に使用）
 */
export function getUserSalt(discordId: string): string | null {
	const db = getDb();
	const row = db
		.prepare("SELECT salt FROM users WHERE discord_id = ?")
		.get(discordId) as { salt: string } | undefined;
	return row?.salt ?? null;
}

/**
 * リッチ返信（Embed/グラフ）の有効/無効を取得する（§3.0.5。未登録ユーザーはデフォルト有効）
 */
export function getUserRichReplyEnabled(discordId: string): boolean {
	const db = getDb();
	const row = db
		.prepare("SELECT rich_reply_enabled FROM users WHERE discord_id = ?")
		.get(discordId) as { rich_reply_enabled: number } | undefined;
	if (!row) return true;
	return row.rich_reply_enabled !== 0;
}

/**
 * リマインドの既定通知前時間（分）を取得する（§3.3.2。未登録ユーザーはデフォルト10分）
 */
export function getUserRemindDefaultMinutes(discordId: string): number {
	const db = getDb();
	const row = db
		.prepare("SELECT remind_default_minutes FROM users WHERE discord_id = ?")
		.get(discordId) as { remind_default_minutes: number } | undefined;
	return row?.remind_default_minutes ?? 10;
}

/**
 * 適用中ペルソナIDを取得する（§4.1。未設定の場合は null）
 * @deprecated v8 で秘書ペルソナは (user_id, bot_id) 単位へ移行。
 *   personaRepo.getActivePersonaIdForBot(userId, botId) を使うこと。本関数はレガシー列を読む。
 */
export function getActivePersonaId(discordId: string): number | null {
	const db = getDb();
	const row = db
		.prepare("SELECT active_persona_id FROM users WHERE discord_id = ?")
		.get(discordId) as { active_persona_id: number | null } | undefined;
	return row?.active_persona_id ?? null;
}

/**
 * ユーザー設定を部分更新する（指定されたフィールドのみ更新）。
 * activePersonaId に null を渡すとペルソナ解除になる。
 */
export function updateUserSettings(
	discordId: string,
	settings: UserSettingsUpdate,
): boolean {
	const sets: string[] = [];
	const values: (string | number | null)[] = [];

	if (settings.richReplyEnabled !== undefined) {
		sets.push("rich_reply_enabled = ?");
		values.push(settings.richReplyEnabled ? 1 : 0);
	}
	if (settings.remindDefaultMinutes !== undefined) {
		// 負値は不正のため0分（=ちょうど開始時刻）に丸める
		sets.push("remind_default_minutes = ?");
		values.push(Math.max(0, Math.floor(settings.remindDefaultMinutes)));
	}
	if (settings.notifyTargetType !== undefined) {
		if (
			settings.notifyTargetType !== "dm" &&
			settings.notifyTargetType !== "channel"
		)
			return false;
		sets.push("notify_target_type = ?");
		values.push(settings.notifyTargetType);
	}
	if (settings.notifyTargetId !== undefined) {
		sets.push("notify_target_id = ?");
		values.push(settings.notifyTargetId);
	}
	if (settings.timezone !== undefined) {
		sets.push("timezone = ?");
		values.push(settings.timezone);
	}
	if (settings.activePersonaId !== undefined) {
		sets.push("active_persona_id = ?");
		values.push(settings.activePersonaId);
	}
	if (sets.length === 0) return false;

	const db = getDb();
	const result = db
		.prepare(
			`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now', 'localtime') WHERE discord_id = ?`,
		)
		.run(...values, discordId);
	return result.changes > 0;
}

// ─── バックアップ設定（§8: ユーザー個人のGoogle Driveへ） ────────────────────

/** バックアップ間隔の許容範囲（時間）: 最短1時間〜最長720時間(30日) */
const BACKUP_INTERVAL_MIN_HOURS = 1;
const BACKUP_INTERVAL_MAX_HOURS = 720;

/**
 * ユーザーのバックアップ設定を取得する（ユーザー未登録の場合は null）
 */
export function getUserBackupConfig(
	discordId: string,
): UserBackupConfig | null {
	const db = getDb();
	const row = db
		.prepare(`
    SELECT backup_enabled, backup_interval_hours, backup_generations, backup_folder_id, backup_last_run_at
    FROM users WHERE discord_id = ?
  `)
		.get(discordId) as
		| {
				backup_enabled: number;
				backup_interval_hours: number;
				backup_generations: number;
				backup_folder_id: string | null;
				backup_last_run_at: string | null;
		  }
		| undefined;

	if (!row) return null;
	return {
		enabled: row.backup_enabled !== 0,
		intervalHours: row.backup_interval_hours,
		generations: row.backup_generations,
		folderId: row.backup_folder_id,
		lastRunAt: row.backup_last_run_at,
	};
}

/**
 * ユーザーのバックアップ設定を更新する（間隔は1〜720時間にクランプ、世代数は1以上）
 */
export function updateUserBackupSettings(
	discordId: string,
	settings: {
		enabled: boolean;
		intervalHours: number;
		generations: number;
		folderId?: string | null;
	},
): boolean {
	const intervalHours = Math.min(
		BACKUP_INTERVAL_MAX_HOURS,
		Math.max(BACKUP_INTERVAL_MIN_HOURS, Math.floor(settings.intervalHours)),
	);
	const generations = Math.max(1, Math.floor(settings.generations));

	const sets = [
		"backup_enabled = ?",
		"backup_interval_hours = ?",
		"backup_generations = ?",
	];
	const values: (string | number | null)[] = [
		settings.enabled ? 1 : 0,
		intervalHours,
		generations,
	];

	if (settings.folderId !== undefined) {
		sets.push("backup_folder_id = ?");
		values.push(settings.folderId);
	}

	const db = getDb();
	const result = db
		.prepare(
			`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now', 'localtime') WHERE discord_id = ?`,
		)
		.run(...values, discordId);
	return result.changes > 0;
}

/**
 * バックアップ最終実行日時を現在時刻で更新する（backupService が実行完了時に呼ぶ）
 */
export function touchBackupLastRun(discordId: string): void {
	const db = getDb();
	db.prepare(`
    UPDATE users SET backup_last_run_at = datetime('now', 'localtime'),
                     updated_at = datetime('now', 'localtime')
    WHERE discord_id = ?
  `).run(discordId);
}
