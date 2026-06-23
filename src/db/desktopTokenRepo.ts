import { getDb } from "./database.js";

// ─── デスクトップクライアント用トークン（desktop_client 設計 backend_api.md §1.4 / §5） ──
// 生トークンは保持しない。token_hash = sha256(生トークン) のみ保存する。
// user_id（Discord ユーザーID）でスコープ。TTL は (last_used_at ?? created_at) + DESKTOP_TOKEN_TTL_DAYS。

export interface DesktopTokenRecord {
	id: number;
	user_id: string;
	token_hash: string;
	device_name: string | null;
	created_at: string;
	last_used_at: string | null;
	revoked: number;
}

/** 発行済みトークンを登録し、作成した行を返す（生トークンは渡さない＝呼び出し側が sha256 化する）。 */
export function addDesktopToken(
	userId: string,
	tokenHash: string,
	deviceName?: string | null,
): DesktopTokenRecord {
	const db = getDb();
	const result = db
		.prepare(
			"INSERT INTO desktop_tokens (user_id, token_hash, device_name) VALUES (?, ?, ?)",
		)
		.run(userId, tokenHash, deviceName ?? null);
	return getDesktopTokenById(result.lastInsertRowid as number)!;
}

export function getDesktopTokenById(
	id: number,
): DesktopTokenRecord | undefined {
	const db = getDb();
	return db.prepare("SELECT * FROM desktop_tokens WHERE id = ?").get(id) as
		| DesktopTokenRecord
		| undefined;
}

/**
 * ハッシュから「有効な（未失効かつ未期限切れ）」トークン行を引く。
 * 期限 = COALESCE(last_used_at, created_at) + ttlDays。期限切れは返さない。
 */
export function getActiveDesktopTokenByHash(
	tokenHash: string,
	ttlDays: number,
): DesktopTokenRecord | undefined {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM desktop_tokens
         WHERE token_hash = ? AND revoked = 0
           AND datetime(COALESCE(last_used_at, created_at), '+' || ? || ' days') > datetime('now','localtime')`,
		)
		.get(tokenHash, ttlDays) as DesktopTokenRecord | undefined;
}

/** アクセス毎のスライディング延長: last_used_at を現在時刻へ更新する。 */
export function touchDesktopToken(id: number): void {
	const db = getDb();
	db.prepare(
		"UPDATE desktop_tokens SET last_used_at = datetime('now','localtime') WHERE id = ?",
	).run(id);
}

/** ユーザーの未失効トークン一覧（端末管理 UI 用）。新しい利用順。 */
export function listDesktopTokensForUser(userId: string): DesktopTokenRecord[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM desktop_tokens
         WHERE user_id = ? AND revoked = 0
         ORDER BY COALESCE(last_used_at, created_at) DESC`,
		)
		.all(userId) as DesktopTokenRecord[];
}

/** 端末単位の失効（本人スコープ）。失効できたら true。 */
export function revokeDesktopToken(id: number, userId: string): boolean {
	const db = getDb();
	const result = db
		.prepare(
			"UPDATE desktop_tokens SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0",
		)
		.run(id, userId);
	return result.changes > 0;
}

/**
 * 当該ユーザーの全デスクトップトークンを失効する（パスワード変更・アカウント削除・権限変更時）。
 * セッションの destroyAllSessionsForUser と対になる。完全削除でテーブルを健全に保つ。
 */
export function revokeAllDesktopTokensForUser(userId: string): void {
	const db = getDb();
	db.prepare("DELETE FROM desktop_tokens WHERE user_id = ?").run(userId);
}
