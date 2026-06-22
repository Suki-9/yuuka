import crypto from "node:crypto";

// ─── DMチャレンジ方式の登録（Discord ID 所有確認） ───────────────────────────
//
// G1対策: Web登録時にクライアントが任意の discordId を主張できる問題を、
// 「主張した Discord ID 宛にBotがワンタイムコードをDMし、返ってきたら本人確認とみなす」
// フローで塞ぐ。確認前の登録データ（パスワード平文・Geminiキー等）はメモリに短時間だけ保持し、
// ログには一切出さない。確認成功時にのみ実ユーザーを作成する（authRoutes.ts）。

export interface PendingRegistration {
	username: string;
	password: string;
	geminiApiKey: string;
	inviteCode: string;
}

interface PendingEntry extends PendingRegistration {
	code: string;
	expiresAt: number;
	attempts: number;
}

const TTL_MS = 10 * 60 * 1000; // 10分
const MAX_ATTEMPTS = 5;

/** discordId -> 保留中の登録 */
const pending = new Map<string, PendingEntry>();

const sweep = setInterval(
	() => {
		const now = Date.now();
		for (const [id, e] of pending) {
			if (e.expiresAt <= now) pending.delete(id);
		}
	},
	5 * 60 * 1000,
);
sweep.unref();

/** 6桁のワンタイムコードを生成する（CSPRNG） */
function generateCode(): string {
	// 000000〜999999 を一様に
	return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * 保留中の登録を作成（同一IDの既存保留は上書き）し、DM送信用のコードを返す。
 * 返り値のコードは Discord DM 送信にのみ使用し、ログ・レスポンスには含めないこと。
 */
export function createPendingRegistration(
	discordId: string,
	data: PendingRegistration,
): string {
	const code = generateCode();
	pending.set(discordId, {
		...data,
		code,
		expiresAt: Date.now() + TTL_MS,
		attempts: 0,
	});
	return code;
}

export type VerifyResult =
	| { ok: true; data: PendingRegistration }
	| {
			ok: false;
			reason: "not_found" | "expired" | "too_many_attempts" | "code_mismatch";
	  };

/**
 * コードを検証する。成功時は保留データを返して当該保留を消費（削除）する。
 * 失敗時は試行回数を加算し、上限超過で保留を破棄する。
 */
export function verifyPendingRegistration(
	discordId: string,
	code: string,
): VerifyResult {
	const entry = pending.get(discordId);
	if (!entry) return { ok: false, reason: "not_found" };
	if (entry.expiresAt <= Date.now()) {
		pending.delete(discordId);
		return { ok: false, reason: "expired" };
	}
	if (entry.attempts >= MAX_ATTEMPTS) {
		pending.delete(discordId);
		return { ok: false, reason: "too_many_attempts" };
	}
	// 定数時間比較
	const a = Buffer.from(entry.code);
	const b = Buffer.from(String(code));
	const match = a.length === b.length && crypto.timingSafeEqual(a, b);
	if (!match) {
		entry.attempts += 1;
		return { ok: false, reason: "code_mismatch" };
	}
	pending.delete(discordId);
	const { username, password, geminiApiKey, inviteCode } = entry;
	return { ok: true, data: { username, password, geminiApiKey, inviteCode } };
}
