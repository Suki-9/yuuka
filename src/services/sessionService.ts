import type { SessionUser } from "../types/contracts.js";
import { getRedisClient } from "../db/redis.js";
import { generateToken, sha256Hex } from "../utils/crypto.js";
import { config } from "../config.js";

/**
 * セッション管理（仕様§5.4.2）
 * - トークン: CSPRNG（generateToken）。保存はハッシュ化キー session:{sha256(token)} のみ
 *   （Redisダンプが漏洩しても生トークンを復元できない）。
 * - TTL: config.sessionTtlDays 日。アクセス毎に自動延長（スライディングウィンドウ）。
 * - ユーザー毎の発行済みセット user_sessions:{userId} を保持し、
 *   パスワード変更・ログアウト(全端末)時に一括失効できる。
 * - Redis不通時は in-memory Map フォールバック（プロセス再起動で消えるのは許容）。
 */

// ─── キー・TTL ───────────────────────────────────────────────────────────────

const SESSION_KEY_PREFIX = "session:";
const USER_SESSIONS_KEY_PREFIX = "user_sessions:";

function sessionKey(tokenHash: string): string {
	return `${SESSION_KEY_PREFIX}${tokenHash}`;
}

function userSessionsKey(userId: string): string {
	return `${USER_SESSIONS_KEY_PREFIX}${userId}`;
}

function ttlSeconds(): number {
	const days =
		Number.isFinite(config.sessionTtlDays) && config.sessionTtlDays > 0
			? config.sessionTtlDays
			: 7;
	return days * 24 * 60 * 60;
}

// ─── in-memory フォールバック ────────────────────────────────────────────────

interface MemorySession {
	user: SessionUser;
	expiresAt: number; // epoch ms
}

/** tokenHash -> セッション */
const memorySessions = new Map<string, MemorySession>();
/** userId -> 発行済み tokenHash のセット */
const memoryUserSessions = new Map<string, Set<string>>();

function memoryRemove(tokenHash: string): void {
	const entry = memorySessions.get(tokenHash);
	memorySessions.delete(tokenHash);
	if (entry) {
		const set = memoryUserSessions.get(entry.user.discordId);
		if (set) {
			set.delete(tokenHash);
			if (set.size === 0) memoryUserSessions.delete(entry.user.discordId);
		}
	}
}

/** 期限切れエントリの定期掃除（10分毎。unrefでプロセス終了は妨げない） */
const sweepTimer = setInterval(
	() => {
		const now = Date.now();
		for (const [tokenHash, entry] of memorySessions) {
			if (entry.expiresAt <= now) memoryRemove(tokenHash);
		}
	},
	10 * 60 * 1000,
);
sweepTimer.unref();

// ─── 公開API ─────────────────────────────────────────────────────────────────

/**
 * セッションを作成し、生トークンを返す（呼び出し側はCookie等でクライアントへ渡す）。
 * 監査ログ（auth.login 等）の記録は server.ts 統合側で行う。
 */
export async function createSession(user: SessionUser): Promise<string> {
	const token = generateToken();
	const tokenHash = sha256Hex(token);
	const payload = JSON.stringify(user);
	const ttl = ttlSeconds();

	const redis = getRedisClient();
	if (redis) {
		try {
			await redis.set(sessionKey(tokenHash), payload, { EX: ttl });
			await redis.sAdd(userSessionsKey(user.discordId), tokenHash);
			// 発行済みセットも最低限セッションと同じだけ生存させる（アクセス毎に延長）
			await redis.expire(userSessionsKey(user.discordId), ttl);
			return token;
		} catch (err) {
			console.error(
				"⚠️ Redisへのセッション保存に失敗しました。in-memoryへフォールバックします:",
				err,
			);
		}
	}

	// in-memory フォールバック
	memorySessions.set(tokenHash, { user, expiresAt: Date.now() + ttl * 1000 });
	let set = memoryUserSessions.get(user.discordId);
	if (!set) {
		set = new Set<string>();
		memoryUserSessions.set(user.discordId, set);
	}
	set.add(tokenHash);
	return token;
}

/**
 * トークンからセッションユーザーを取得する。
 * 取得成功時はTTLを再設定する（スライディングウィンドウ、§5.4.2）。
 */
export async function getSession(token: string): Promise<SessionUser | null> {
	if (!token) return null;
	const tokenHash = sha256Hex(token);
	const ttl = ttlSeconds();

	const redis = getRedisClient();
	if (redis) {
		try {
			const raw = await redis.get(sessionKey(tokenHash));
			if (raw) {
				let user: SessionUser;
				try {
					user = JSON.parse(raw) as SessionUser;
				} catch {
					// 破損したセッションデータは破棄する
					await redis.del(sessionKey(tokenHash));
					return null;
				}
				// スライディングウィンドウ: アクセス毎にTTLを延長
				await redis.expire(sessionKey(tokenHash), ttl);
				await redis.expire(userSessionsKey(user.discordId), ttl);
				return user;
			}
			// Redis稼働中にキーが無い場合もin-memoryを確認する
			// （Redis一時停止中に発行されたセッションの救済）
		} catch (err) {
			console.error(
				"⚠️ Redisからのセッション取得に失敗しました。in-memoryを確認します:",
				err,
			);
		}
	}

	// in-memory フォールバック
	const entry = memorySessions.get(tokenHash);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		memoryRemove(tokenHash);
		return null;
	}
	entry.expiresAt = Date.now() + ttl * 1000; // スライディングウィンドウ
	return entry.user;
}

/**
 * セッションのTTLのみを延長する（ボディ不要の軽量タッチ。成功時 true）。
 */
export async function touchSession(token: string): Promise<boolean> {
	return (await getSession(token)) !== null;
}

/**
 * セッションを失効させる（ログアウト時、§5.4.2）。
 */
export async function destroySession(token: string): Promise<void> {
	if (!token) return;
	const tokenHash = sha256Hex(token);

	const redis = getRedisClient();
	if (redis) {
		try {
			// 発行済みセットからも除去するため、先にユーザーを特定する
			const raw = await redis.get(sessionKey(tokenHash));
			await redis.del(sessionKey(tokenHash));
			if (raw) {
				try {
					const user = JSON.parse(raw) as SessionUser;
					await redis.sRem(userSessionsKey(user.discordId), tokenHash);
				} catch {
					// パース不能でもセッション本体は削除済みのため続行
				}
			}
		} catch (err) {
			console.error("⚠️ Redisのセッション削除に失敗しました:", err);
		}
	}

	// in-memory 側も常に削除（両方に存在し得るため）
	memoryRemove(tokenHash);
}

/**
 * 指定ユーザーの全セッションを即時失効させる（パスワード変更時・Admin強制ログアウト用）。
 */
export async function destroyAllSessionsForUser(userId: string): Promise<void> {
	const redis = getRedisClient();
	if (redis) {
		try {
			const tokenHashes = await redis.sMembers(userSessionsKey(userId));
			if (tokenHashes.length > 0) {
				await redis.del(tokenHashes.map((h) => sessionKey(h)));
			}
			await redis.del(userSessionsKey(userId));
		} catch (err) {
			console.error("⚠️ Redisの全セッション失効に失敗しました:", err);
		}
	}

	// in-memory 側も常に失効
	const set = memoryUserSessions.get(userId);
	if (set) {
		for (const tokenHash of set) {
			memorySessions.delete(tokenHash);
		}
		memoryUserSessions.delete(userId);
	}
}
