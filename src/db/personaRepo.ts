import { getDb } from "./database.js";

// ─── ペルソナ管理・マーケットプレイス（§4.1） ────────────────────────────────
// ペルソナの実体はシステムプロンプト文字列。ユーザー毎に独立して保持され、
// 公開（is_public）したペルソナは他ユーザーがインポート（独立コピー）できる。

/** 上限文字数（§4.1.2） */
export const PERSONA_MAX_LENGTH = 20000;

export interface PersonaRecord {
	id: number;
	owner_id: string;
	name: string;
	prompt: string;
	is_public: number;
	created_at: string;
	updated_at: string;
}

export interface PublicPersonaView {
	id: number;
	name: string;
	prompt_preview: string;
	prompt_length: number;
	owner_username: string;
	updated_at: string;
}

function validatePersonaInput(name: string, prompt: string): void {
	if (!name.trim()) {
		throw new Error("ペルソナ名は必須です");
	}
	if (prompt.length > PERSONA_MAX_LENGTH) {
		throw new Error(
			`ペルソナは${PERSONA_MAX_LENGTH.toLocaleString()}文字以内です（現在: ${prompt.length.toLocaleString()}文字）`,
		);
	}
}

export function createPersona(
	ownerId: string,
	name: string,
	prompt: string,
): PersonaRecord {
	validatePersonaInput(name, prompt);
	const db = getDb();
	const result = db
		.prepare("INSERT INTO personas (owner_id, name, prompt) VALUES (?, ?, ?)")
		.run(ownerId, name.trim(), prompt);
	return getPersonaById(Number(result.lastInsertRowid))!;
}

export function getPersonaById(id: number): PersonaRecord | undefined {
	const db = getDb();
	return db.prepare("SELECT * FROM personas WHERE id = ?").get(id) as
		| PersonaRecord
		| undefined;
}

/**
 * ペルソナを更新する（所有者本人のみ）
 */
export function updatePersona(
	ownerId: string,
	id: number,
	input: { name?: string; prompt?: string; isPublic?: boolean },
): boolean {
	const db = getDb();
	const current = db
		.prepare("SELECT * FROM personas WHERE id = ? AND owner_id = ?")
		.get(id, ownerId) as PersonaRecord | undefined;
	if (!current) return false;

	const name = input.name !== undefined ? input.name : current.name;
	const prompt = input.prompt !== undefined ? input.prompt : current.prompt;
	validatePersonaInput(name, prompt);

	const isPublic =
		input.isPublic !== undefined ? (input.isPublic ? 1 : 0) : current.is_public;

	const result = db
		.prepare(
			`UPDATE personas SET name = ?, prompt = ?, is_public = ?, updated_at = datetime('now', 'localtime')
       WHERE id = ? AND owner_id = ?`,
		)
		.run(name.trim(), prompt, isPublic, id, ownerId);

	// 非公開化された場合、このペルソナを推奨ペルソナにしているBotから解除する（§5.2.1: is_public のみ設定可）
	if (current.is_public === 1 && isPublic === 0) {
		db.prepare(
			"UPDATE bots SET recommended_persona_id = NULL WHERE recommended_persona_id = ?",
		).run(id);
	}

	return result.changes > 0;
}

/**
 * ペルソナを削除する（所有者本人のみ）。
 * このペルソナを適用中の (user,bot) 適用状態・Botの推奨設定も解除する。
 */
export function deletePersona(ownerId: string, id: number): boolean {
	const db = getDb();
	const tx = db.transaction(() => {
		const result = db
			.prepare("DELETE FROM personas WHERE id = ? AND owner_id = ?")
			.run(id, ownerId);
		if (result.changes === 0) return false;
		db.prepare("DELETE FROM bot_active_personas WHERE persona_id = ?").run(id);
		db.prepare(
			"UPDATE bots SET recommended_persona_id = NULL WHERE recommended_persona_id = ?",
		).run(id);
		return true;
	});
	return tx();
}

export function listPersonasForUser(ownerId: string): PersonaRecord[] {
	const db = getDb();
	return db
		.prepare(
			"SELECT * FROM personas WHERE owner_id = ? ORDER BY updated_at DESC",
		)
		.all(ownerId) as PersonaRecord[];
}

/** マーケットプレイスの公開ペルソナ一覧（§4.1.3。プロンプトはプレビューのみ） */
export function listPublicPersonas(): PublicPersonaView[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT p.id, p.name, p.prompt, p.updated_at, COALESCE(u.username, '不明') as owner_username
       FROM personas p
       LEFT JOIN users u ON u.discord_id = p.owner_id
       WHERE p.is_public = 1
       ORDER BY p.updated_at DESC`,
		)
		.all() as Array<{
		id: number;
		name: string;
		prompt: string;
		updated_at: string;
		owner_username: string;
	}>;
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		prompt_preview: r.prompt.slice(0, 200),
		prompt_length: r.prompt.length,
		owner_username: r.owner_username,
		updated_at: r.updated_at,
	}));
}

/**
 * 公開ペルソナをインポートする（§4.1.3: 独立したコピー。元の変更は反映されない）
 * @returns 複製された新しいペルソナ（対象が非公開・不存在なら null）
 */
export function importPersona(
	userId: string,
	publicPersonaId: number,
): PersonaRecord | null {
	const db = getDb();
	const source = getPersonaById(publicPersonaId);
	if (!source || source.is_public !== 1) return null;

	const result = db
		.prepare("INSERT INTO personas (owner_id, name, prompt) VALUES (?, ?, ?)")
		.run(userId, source.name, source.prompt);
	return getPersonaById(Number(result.lastInsertRowid)) ?? null;
}

/**
 * (user_id, bot_id) の適用中ペルソナのプロンプトを取得する（gemini.ts のシステムプロンプト構築用）。
 * v8: 秘書ペルソナはユーザー単位ではなく Bot 単位で独立する（bot_active_personas）。
 */
export function getActivePersonaPrompt(
	userId: string,
	botId: string,
): string | null {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT p.prompt FROM bot_active_personas a
       JOIN personas p ON p.id = a.persona_id
       WHERE a.user_id = ? AND a.bot_id = ?`,
		)
		.get(userId, botId) as { prompt: string } | undefined;
	return row?.prompt ?? null;
}

/**
 * (user_id, bot_id) の適用中ペルソナID を取得する（管理画面の表示用）。未適用は null。
 */
export function getActivePersonaIdForBot(
	userId: string,
	botId: string,
): number | null {
	const db = getDb();
	const row = db
		.prepare(
			"SELECT persona_id FROM bot_active_personas WHERE user_id = ? AND bot_id = ?",
		)
		.get(userId, botId) as { persona_id: number } | undefined;
	return row?.persona_id ?? null;
}

/**
 * (user_id, bot_id) に適用するペルソナを設定する。null でデフォルトへ戻す（適用解除）。
 * 呼び出し側で personaId の所有権（owner_id === userId）を検証すること。
 */
export function setActivePersonaForBot(
	userId: string,
	botId: string,
	personaId: number | null,
): void {
	const db = getDb();
	if (personaId === null) {
		db.prepare(
			"DELETE FROM bot_active_personas WHERE user_id = ? AND bot_id = ?",
		).run(userId, botId);
		return;
	}
	db.prepare(
		`INSERT INTO bot_active_personas (user_id, bot_id, persona_id, updated_at)
     VALUES (?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(user_id, bot_id) DO UPDATE SET persona_id = excluded.persona_id, updated_at = datetime('now', 'localtime')`,
	).run(userId, botId, personaId);
}

// ─── Admin マーケットプレイス管理（§5.3.2） ──────────────────────────────────

/** ペルソナを強制的に非公開化する（Admin専用。Botの推奨設定も解除） */
export function adminUnpublishPersona(id: number): boolean {
	const db = getDb();
	const tx = db.transaction(() => {
		const result = db
			.prepare(
				"UPDATE personas SET is_public = 0, updated_at = datetime('now', 'localtime') WHERE id = ?",
			)
			.run(id);
		if (result.changes === 0) return false;
		db.prepare(
			"UPDATE bots SET recommended_persona_id = NULL WHERE recommended_persona_id = ?",
		).run(id);
		return true;
	});
	return tx();
}

/** ペルソナを強制削除する（Admin専用） */
export function adminDeletePersona(id: number): boolean {
	const db = getDb();
	const tx = db.transaction(() => {
		const result = db.prepare("DELETE FROM personas WHERE id = ?").run(id);
		if (result.changes === 0) return false;
		db.prepare("DELETE FROM bot_active_personas WHERE persona_id = ?").run(id);
		db.prepare(
			"UPDATE bots SET recommended_persona_id = NULL WHERE recommended_persona_id = ?",
		).run(id);
		return true;
	});
	return tx();
}
