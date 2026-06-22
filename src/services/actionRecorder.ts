import { getRedisClient } from "../db/redis.js";

// ─── 操作履歴レコーダー（§3.6 実行ベースマクロ登録用） ────────────────────────
// gemini.ts が Function Call の実行毎に記録し、ユーザーが「今の操作を覚えておいて」
// と指示した際に getRecentActions で直近の操作列を取り出してマクロ化する。
// Redis fc_history:{userId}（直近30件・TTL 2時間）。Redis不通時は in-memory フォールバック。

export interface RecordedAction {
	name: string;
	argsSummary: string;
	at: string; // ISO 8601
}

const MAX_ACTIONS = 30;
const TTL_SECONDS = 2 * 60 * 60; // 2時間

/**
 * 記録から除外するFunction名（秘匿系・記録系自身・マクロ管理系）。
 * 認証情報系は値が引数に含まれ得るため必ず除外する（§6.3.2）。
 */
const EXCLUDED_FUNCTIONS = new Set([
	// 認証情報系（pwmanager）
	"listCredentialServices",
	"addCredential",
	"updateCredential",
	"deleteCredential",
	// browserFillCredential はブラウザ操作の一部として手順上重要だが、
	// 引数にセレクタしか含まれないため記録する（パスワード値は引数に存在しない）
	// マクロ管理系自身（自己言及の無限ループ・ノイズ防止）
	"savePlaybook",
	"findPlaybooks",
	"deletePlaybook",
	"runPlaybook",
	"getRecentActionHistory",
]);

/** 秘匿すべき引数キーのパターン */
const SECRET_ARG_PATTERN = /password|secret|token|api_?key|credential_value/i;

const memoryFallback = new Map<
	string,
	{ actions: RecordedAction[]; expiresAt: number }
>();

function redisKey(userId: string): string {
	return `fc_history:${userId}`;
}

/** 引数を要約文字列へ変換する（各値150文字truncate・秘匿キーはマスク） */
function summarizeArgs(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null) continue;
		let str: string;
		if (SECRET_ARG_PATTERN.test(key)) {
			str = "(秘匿)";
		} else if (typeof value === "string") {
			str = value.length > 150 ? value.slice(0, 150) + "…" : value;
		} else {
			const json = JSON.stringify(value);
			str = json.length > 150 ? json.slice(0, 150) + "…" : json;
		}
		parts.push(`${key}=${str}`);
	}
	return parts.join(", ");
}

/**
 * Function Call を操作履歴に記録する（gemini.ts のディスパッチループから呼ばれる）。
 * 失敗してもユーザー応答をブロックしない（呼び出し側で .catch 済み想定だが内部でも握る）。
 */
export async function recordFunctionCall(
	userId: string,
	name: string,
	args: Record<string, unknown>,
): Promise<void> {
	if (EXCLUDED_FUNCTIONS.has(name)) return;

	const action: RecordedAction = {
		name,
		argsSummary: summarizeArgs(args),
		at: new Date().toISOString(),
	};

	const redis = getRedisClient();
	if (redis) {
		try {
			const key = redisKey(userId);
			await redis.rPush(key, JSON.stringify(action));
			await redis.lTrim(key, -MAX_ACTIONS, -1);
			await redis.expire(key, TTL_SECONDS);
			return;
		} catch (err) {
			console.warn(
				"[ActionRecorder] Redisへの記録に失敗しました（in-memoryへフォールバック）:",
				err,
			);
		}
	}

	// in-memory フォールバック
	const now = Date.now();
	const entry = memoryFallback.get(userId);
	if (!entry || entry.expiresAt < now) {
		memoryFallback.set(userId, {
			actions: [action],
			expiresAt: now + TTL_SECONDS * 1000,
		});
	} else {
		entry.actions.push(action);
		if (entry.actions.length > MAX_ACTIONS) {
			entry.actions.splice(0, entry.actions.length - MAX_ACTIONS);
		}
		entry.expiresAt = now + TTL_SECONDS * 1000;
	}
}

/** 直近の操作履歴を取得する（古い順） */
export async function getRecentActions(
	userId: string,
): Promise<RecordedAction[]> {
	const redis = getRedisClient();
	if (redis) {
		try {
			const items = await redis.lRange(redisKey(userId), 0, -1);
			return items
				.map((s) => {
					try {
						return JSON.parse(s) as RecordedAction;
					} catch {
						return null;
					}
				})
				.filter((a): a is RecordedAction => a !== null);
		} catch (err) {
			console.warn("[ActionRecorder] Redisからの取得に失敗しました:", err);
		}
	}

	const entry = memoryFallback.get(userId);
	if (!entry || entry.expiresAt < Date.now()) return [];
	return [...entry.actions];
}

/** 操作履歴をクリアする（マクロ保存後の整理用） */
export async function clearActions(userId: string): Promise<void> {
	const redis = getRedisClient();
	if (redis) {
		try {
			await redis.del(redisKey(userId));
		} catch {}
	}
	memoryFallback.delete(userId);
}
