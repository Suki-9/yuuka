import crypto from "node:crypto";
import { config } from "../config.js";
import { addAuditLog } from "../db/auditRepo.js";
import {
	addDesktopToken,
	getActiveDesktopTokenByHash,
	touchDesktopToken,
} from "../db/desktopTokenRepo.js";
import { getRedisClient } from "../db/redis.js";
import { getUserByDiscordId } from "../db/userRepo.js";
import type { SessionUser } from "../types/contracts.js";
import { generateToken, sha256Hex } from "../utils/crypto.js";

// ─── OAuth デバイスフロー（RFC 8628 型） + デスクトップトークン発行/検証 ──────────
// 設計: docs/design/desktop_client/backend_api.md §1。
// - デバイスコードの一時状態は Redis（揮発で十分）。Redis 不通時はインメモリへフォールバック。
// - 発行済みトークンのみ SQLite（desktop_tokens）へ sha256 で永続化する。

/** ポーリング最小間隔（秒）。token エンドポイントが interval として返す。 */
const POLL_INTERVAL_SEC = 5;

/** device_code レコードの Redis キー接頭辞（値は sha256(device_code) でキー化）。 */
const DEVICE_AUTH_PREFIX = "device_auth:";
/** user_code → sha256(device_code) の逆引きインデックス（approve は user_code しか持たないため）。 */
const DEVICE_USERCODE_PREFIX = "device_usercode:";

/** Crockford Base32（紛らわしい I/L/O/U を除く）。user_code の文字空間。 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface DeviceAuthRecord {
	userCode: string;
	status: "pending" | "approved";
	deviceName: string | null;
	approvedUser?: string;
	createdAt: number;
	/** slow_down 判定用: 直近に token ポーリングした時刻（ms）。 */
	lastPolledAt?: number;
}

// ── インメモリフォールバック（Redis 不通時。セッションと同方針） ──
const memoryStore = new Map<
	string,
	{ rec: DeviceAuthRecord; expiresAt: number }
>();
const memoryUserCodeIndex = new Map<
	string,
	{ hash: string; expiresAt: number }
>();

function sweepMemory(): void {
	const now = Date.now();
	for (const [k, v] of memoryStore)
		if (v.expiresAt <= now) memoryStore.delete(k);
	for (const [k, v] of memoryUserCodeIndex)
		if (v.expiresAt <= now) memoryUserCodeIndex.delete(k);
}
setInterval(sweepMemory, 60_000).unref();

function deviceAuthKey(hash: string): string {
	return `${DEVICE_AUTH_PREFIX}${hash}`;
}
function userCodeKey(userCode: string): string {
	return `${DEVICE_USERCODE_PREFIX}${userCode}`;
}

/** 人間可読な user_code（Crockford Base32 8 文字、XXXX-XXXX 形式）を生成。 */
function generateUserCode(): string {
	const bytes = crypto.randomBytes(8);
	let s = "";
	for (let i = 0; i < 8; i++) s += CROCKFORD[bytes[i] % CROCKFORD.length];
	return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 承認ページの公開 URL（baseUrl 未設定のローカル開発では host:port を使う）。 */
function verificationBase(): string {
	if (config.baseUrl) return config.baseUrl.replace(/\/$/, "");
	return `http://${config.host}:${config.port}`;
}

// ── Redis/メモリ 抽象（device_auth レコードの get/set/del と user_code インデックス） ──

async function storeRecord(
	hash: string,
	rec: DeviceAuthRecord,
	ttlSec: number,
): Promise<void> {
	const redis = getRedisClient();
	const payload = JSON.stringify(rec);
	if (redis) {
		try {
			await redis.set(deviceAuthKey(hash), payload, { EX: ttlSec });
			await redis.set(userCodeKey(rec.userCode), hash, { EX: ttlSec });
			return;
		} catch {
			// フォールバックへ
		}
	}
	const expiresAt = Date.now() + ttlSec * 1000;
	memoryStore.set(hash, { rec, expiresAt });
	memoryUserCodeIndex.set(rec.userCode, { hash, expiresAt });
}

async function loadRecord(hash: string): Promise<DeviceAuthRecord | null> {
	const redis = getRedisClient();
	if (redis) {
		try {
			const raw = await redis.get(deviceAuthKey(hash));
			return raw ? (JSON.parse(raw) as DeviceAuthRecord) : null;
		} catch {
			// フォールバックへ
		}
	}
	const entry = memoryStore.get(hash);
	if (!entry || entry.expiresAt <= Date.now()) return null;
	return entry.rec;
}

/** レコードを更新する（残存 TTL を維持。失効時間は変えない）。 */
async function updateRecord(
	hash: string,
	rec: DeviceAuthRecord,
): Promise<void> {
	const redis = getRedisClient();
	if (redis) {
		try {
			// 残り TTL を維持して値だけ差し替える
			await redis.set(deviceAuthKey(hash), JSON.stringify(rec), {
				KEEPTTL: true,
			});
			return;
		} catch {
			// フォールバックへ
		}
	}
	const entry = memoryStore.get(hash);
	if (entry) entry.rec = rec;
}

async function deleteRecord(hash: string, userCode: string): Promise<void> {
	const redis = getRedisClient();
	if (redis) {
		try {
			await redis.del([deviceAuthKey(hash), userCodeKey(userCode)]);
		} catch {
			// フォールバックも消す
		}
	}
	memoryStore.delete(hash);
	memoryUserCodeIndex.delete(userCode);
}

async function resolveHashByUserCode(userCode: string): Promise<string | null> {
	const redis = getRedisClient();
	if (redis) {
		try {
			const hash = await redis.get(userCodeKey(userCode));
			return hash ?? null;
		} catch {
			// フォールバックへ
		}
	}
	const entry = memoryUserCodeIndex.get(userCode);
	if (!entry || entry.expiresAt <= Date.now()) return null;
	return entry.hash;
}

// ─── 公開 API ──────────────────────────────────────────────────────────────

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	interval: number;
	expires_in: number;
}

/** §1.1: デバイスコード/ユーザーコードを発行する（auth: none）。 */
export async function createDeviceCode(
	deviceName?: string,
): Promise<DeviceCodeResponse> {
	const ttlSec = config.desktopDeviceCodeTtlSec;
	const deviceCode = generateToken(32); // 不透明・推測不能
	const hash = sha256Hex(deviceCode);

	// user_code の衝突回避（短命・空間は十分大きいが念のため数回リトライ）
	let userCode = generateUserCode();
	for (let i = 0; i < 5; i++) {
		const existing = await resolveHashByUserCode(userCode);
		if (!existing) break;
		userCode = generateUserCode();
	}

	const rec: DeviceAuthRecord = {
		userCode,
		status: "pending",
		deviceName: deviceName ?? null,
		createdAt: Date.now(),
	};
	await storeRecord(hash, rec, ttlSec);

	const base = verificationBase();
	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: `${base}/device`,
		verification_uri_complete: `${base}/device?code=${encodeURIComponent(userCode)}`,
		interval: POLL_INTERVAL_SEC,
		expires_in: ttlSec,
	};
}

export type ApproveResult =
	| { ok: true; deviceName: string | null }
	| { ok: false; reason: "not_found" | "expired" };

/** §1.2: ブラウザ（ログイン済み本人）が user_code を承認する（auth: user）。 */
export async function approveDeviceCode(
	userCode: string,
	approvedUser: string,
): Promise<ApproveResult> {
	const normalized = userCode.trim().toUpperCase();
	const hash = await resolveHashByUserCode(normalized);
	if (!hash) return { ok: false, reason: "not_found" };
	const rec = await loadRecord(hash);
	if (!rec) return { ok: false, reason: "expired" };

	rec.status = "approved";
	rec.approvedUser = approvedUser;
	await updateRecord(hash, rec);
	addAuditLog(
		approvedUser,
		"desktop.device_approve",
		rec.deviceName ?? undefined,
	);
	return { ok: true, deviceName: rec.deviceName };
}

export type TokenExchangeResult =
	| { status: "authorization_pending" }
	| { status: "slow_down" }
	| { status: "expired_token" }
	| {
			status: "approved";
			access_token: string;
			expires_in: number;
			user: SessionUser;
	  };

/** §1.3: アプリが device_code をトークンへ交換する（auth: none, device_code で認可）。 */
export async function exchangeDeviceToken(
	deviceCode: string,
): Promise<TokenExchangeResult> {
	const hash = sha256Hex(deviceCode);
	const rec = await loadRecord(hash);
	if (!rec) return { status: "expired_token" };

	// slow_down: interval より短い間隔での連続ポーリングを抑制する
	const now = Date.now();
	if (rec.lastPolledAt && now - rec.lastPolledAt < POLL_INTERVAL_SEC * 1000) {
		return { status: "slow_down" };
	}
	rec.lastPolledAt = now;
	await updateRecord(hash, rec);

	if (rec.status !== "approved" || !rec.approvedUser) {
		return { status: "authorization_pending" };
	}

	// 承認済みユーザーが実在するか確認（削除済み等の防御）
	const user = getUserByDiscordId(rec.approvedUser);
	if (!user) {
		await deleteRecord(hash, rec.userCode);
		return { status: "expired_token" };
	}

	// 1 回だけトークン化（device_code は使い切り）
	const rawToken = issueDesktopToken(rec.approvedUser, rec.deviceName);
	await deleteRecord(hash, rec.userCode);

	return {
		status: "approved",
		access_token: rawToken,
		expires_in: config.desktopTokenTtlDays * 24 * 60 * 60,
		user: {
			discordId: user.discord_id,
			username: user.username,
			role: (user.role as "user" | "admin") || "user",
		},
	};
}

/**
 * 長命デスクトップトークンを発行する。生トークンを返し、サーバは sha256 のみ保存する。
 * （desktop_tokens 表 / backend_api.md §1.4）
 */
export function issueDesktopToken(
	userId: string,
	deviceName?: string | null,
): string {
	const rawToken = generateToken(32);
	const tokenHash = sha256Hex(rawToken);
	const row = addDesktopToken(userId, tokenHash, deviceName ?? null);
	addAuditLog(userId, "desktop.token_issue", String(row.id));
	return rawToken;
}

/**
 * Bearer トークンを検証し SessionUser を返す（無効/失効/期限切れは null）。
 * 有効ならスライディング延長（last_used_at 更新）。REST（routeRegistry）と WS upgrade の双方で使う。
 */
export function verifyToken(rawToken: string): SessionUser | null {
	if (!rawToken) return null;
	const tokenHash = sha256Hex(rawToken);
	const row = getActiveDesktopTokenByHash(
		tokenHash,
		config.desktopTokenTtlDays,
	);
	if (!row) return null;
	const user = getUserByDiscordId(row.user_id);
	if (!user) return null;
	touchDesktopToken(row.id);
	return {
		discordId: user.discord_id,
		username: user.username,
		role: (user.role as "user" | "admin") || "user",
	};
}
