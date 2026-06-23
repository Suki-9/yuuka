import crypto from "node:crypto";
import { Algorithm, hashRawSync } from "@node-rs/argon2";
import { config } from "../config.js";

// ─── システム鍵（APIキー・トークン・Webhookシークレット等の保存時暗号化） ────

// 暗号鍵を導出するための固定ソルト（後方互換のため変更不可）
const SYSTEM_SALT = "yuuka-seminar-accounting-salt";

// プレリリース版が YUUKA_ENCRYPTION_SECRET 未設定時に使用していた鍵。
// YUUKA_ENCRYPTION_SECRET_NEW によるローテーション（旧鍵からの移行）でのみ参照する。
const LEGACY_FALLBACK_SECRET = "yuuka-seminar-2026-system-key";

let systemKey: Buffer | null = null;

function deriveSystemKey(secret: string): Buffer {
	return crypto.scryptSync(secret, SYSTEM_SALT, 32);
}

/**
 * システム全体で使用する AES-256 暗号鍵を取得する
 */
function getEncryptionKey(): Buffer {
	if (!systemKey) {
		if (!config.secretKey) {
			throw new Error(
				"環境変数 YUUKA_ENCRYPTION_SECRET が設定されていません。十分に長いランダム文字列を設定してください（.env.example 参照）。",
			);
		}
		systemKey = deriveSystemKey(config.secretKey);
	}
	return systemKey;
}

function encryptWithKey(
	key: Buffer,
	text: string,
): { encrypted: string; iv: string; authTag: string } {
	const iv = crypto.randomBytes(12); // GCM では 12 バイトの IV が推奨されます
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	let encrypted = cipher.update(text, "utf8", "hex");
	encrypted += cipher.final("hex");
	return {
		encrypted,
		iv: iv.toString("hex"),
		authTag: cipher.getAuthTag().toString("hex"),
	};
}

function decryptWithKey(
	key: Buffer,
	encrypted: string,
	ivHex: string,
	authTagHex: string,
): string {
	const iv = Buffer.from(ivHex, "hex");
	const authTag = Buffer.from(authTagHex, "hex");
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(authTag);
	let decrypted = decipher.update(encrypted, "hex", "utf8");
	decrypted += decipher.final("utf8");
	return decrypted;
}

/**
 * プレーンな文字列をシステム鍵で aes-256-gcm 暗号化する
 * 用途: APIキー・Discordトークン・OAuthトークン・Webhookシークレット・MCP認証情報
 */
export function encryptText(text: string): {
	encrypted: string;
	iv: string;
	authTag: string;
} {
	return encryptWithKey(getEncryptionKey(), text);
}

/**
 * システム鍵で暗号化された文字列を復号する
 */
export function decryptText(
	encrypted: string,
	ivHex: string,
	authTagHex: string,
): string {
	return decryptWithKey(getEncryptionKey(), encrypted, ivHex, authTagHex);
}

// ─── ユーザー鍵（パスワードマネージャ §6.2） ─────────────────────────────────
// YUUKA_ENCRYPTION_SECRET + ユーザー固有ソルト を Argon2id に通して 32 バイト鍵を導出する。
// DBが漏洩しても YUUKA_ENCRYPTION_SECRET なしには復号できない構成。

const userKeyCache = new Map<string, Buffer>();

/** Argon2id パラメータ（OWASP推奨の最小構成準拠） */
const ARGON2_OPTS = {
	algorithm: Algorithm.Argon2id,
	memoryCost: 19456, // 19 MiB
	timeCost: 2,
	parallelism: 1,
	outputLen: 32,
} as const;

function deriveUserKey(userSaltHex: string, secret?: string): Buffer {
	const material = secret ?? config.secretKey;
	if (!material) {
		throw new Error(
			"環境変数 YUUKA_ENCRYPTION_SECRET が設定されていません。十分に長いランダム文字列を設定してください（.env.example 参照）。",
		);
	}
	const salt = Buffer.from(userSaltHex, "hex");
	if (salt.length < 8) {
		throw new Error("ユーザーソルトが不正です（8バイト以上のhexが必要）");
	}
	return Buffer.from(hashRawSync(material, { ...ARGON2_OPTS, salt }));
}

/** ユーザー固有鍵を取得する（メモリ内キャッシュ付き） */
function getUserKey(userId: string, userSaltHex: string): Buffer {
	const cached = userKeyCache.get(userId);
	if (cached) return cached;
	const key = deriveUserKey(userSaltHex);
	userKeyCache.set(userId, key);
	return key;
}

/**
 * ユーザー固有鍵で aes-256-gcm 暗号化する（パスワードマネージャ専用）
 * @param userSaltHex users.salt（CSPRNG生成のhex文字列）
 */
export function encryptForUser(
	userId: string,
	userSaltHex: string,
	text: string,
): { encrypted: string; iv: string; authTag: string } {
	return encryptWithKey(getUserKey(userId, userSaltHex), text);
}

/**
 * ユーザー固有鍵で復号する（パスワードマネージャ専用）
 */
export function decryptForUser(
	userId: string,
	userSaltHex: string,
	encrypted: string,
	ivHex: string,
	authTagHex: string,
): string {
	return decryptWithKey(
		getUserKey(userId, userSaltHex),
		encrypted,
		ivHex,
		authTagHex,
	);
}

/** ユーザー登録時のソルト生成（CSPRNG, 16バイトhex） */
export function generateUserSalt(): string {
	return crypto.randomBytes(16).toString("hex");
}

/** CSPRNG による URLセーフなランダムトークン生成（Webhookトークン・セッション等） */
export function generateToken(bytes: number = 32): string {
	return crypto.randomBytes(bytes).toString("base64url");
}

/** SHA-256 ハッシュ（セッショントークンのキー化等） */
export function sha256Hex(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

// ─── YUUKA_ENCRYPTION_SECRET ローテーション（§6.2.1） ─────────────────────────────────────

interface EncryptedColumnSpec {
	table: string;
	/** 行を一意に特定する列 */
	keyColumns: string[];
	/** [暗号文, IV, authTag] の列名トリプレット */
	columns: [string, string, string];
	/** ユーザー鍵で暗号化されている場合、salt解決のための user_id 列名 */
	userScopedBy?: string;
}

/** システム内の全暗号化カラムのレジストリ（ローテーション対象） */
const ENCRYPTED_COLUMNS: EncryptedColumnSpec[] = [
	{
		table: "users",
		keyColumns: ["discord_id"],
		columns: [
			"gemini_api_key_encrypted",
			"gemini_api_key_iv",
			"gemini_api_key_tag",
		],
	},
	{
		table: "users",
		keyColumns: ["discord_id"],
		columns: [
			"google_refresh_token_encrypted",
			"google_refresh_token_iv",
			"google_refresh_token_tag",
		],
	},
	{
		table: "bots",
		keyColumns: ["id"],
		columns: [
			"discord_token_encrypted",
			"discord_token_iv",
			"discord_token_tag",
		],
	},
	{
		table: "webhook_endpoints",
		keyColumns: ["id"],
		columns: ["secret_encrypted", "secret_iv", "secret_tag"],
	},
	{
		table: "mcp_servers",
		keyColumns: ["id"],
		columns: [
			"auth_credential_encrypted",
			"auth_credential_iv",
			"auth_credential_tag",
		],
	},
	{
		table: "credentials",
		keyColumns: ["user_id", "service_name"],
		columns: ["encrypted_password", "iv", "auth_tag"],
		userScopedBy: "user_id",
	},
];

/**
 * YUUKA_ENCRYPTION_SECRET_NEW が設定されている場合、全暗号化エントリを旧キーで復号→新キーで再暗号化する。
 * 手順（仕様§6.2.1）:
 *   1. YUUKA_ENCRYPTION_SECRET_NEW を環境変数/config に追加して起動 → 本関数が再暗号化を実行
 *   2. 完了後、YUUKA_ENCRYPTION_SECRET_NEW の値を YUUKA_ENCRYPTION_SECRET に昇格し、YUUKA_ENCRYPTION_SECRET_NEW を削除して再起動
 *
 * better-sqlite3 の Database インスタンスを引数に取る（循環import回避のため migrations 後に index.ts から呼ぶ）。
 */
export function rotateSecretKey(db: import("better-sqlite3").Database): void {
	if (!config.secretKeyNew) return;
	if (config.secretKeyNew === config.secretKey) {
		console.warn(
			"⚠️ YUUKA_ENCRYPTION_SECRET_NEW が YUUKA_ENCRYPTION_SECRET と同一のため、ローテーションをスキップします。",
		);
		return;
	}

	console.log("🔄 YUUKA_ENCRYPTION_SECRET ローテーションを開始します...");
	// 旧鍵の決定: 通常は現行 YUUKA_ENCRYPTION_SECRET。空の場合のみプレリリース版の既知フォールバック鍵
	// からの移行とみなす（ハードコード鍵で保護されていた可能性のあるデータの救済）。
	// セキュリティ警告: フォールバック鍵で保護されていたデータは「漏えい済み」とみなし、移行後に
	// 各プロバイダ側でトークン/APIキー等をローテーションすること。
	const usingLegacyFallback = !config.secretKey;
	const oldSecret = config.secretKey || LEGACY_FALLBACK_SECRET;
	if (usingLegacyFallback) {
		console.warn(
			"⚠️ YUUKA_ENCRYPTION_SECRET が未設定のため、既知のプレリリース版フォールバック鍵で復号して再暗号化します。\n" +
				"   この鍵はソース公開の既知値です。移行完了後、保存済みの Discordトークン・APIキー・OAuthトークン・\n" +
				"   Webhook/MCP シークレット等は漏えい済みとみなし、各プロバイダ側で必ずローテーションしてください。",
		);
	}
	const oldSystemKey = deriveSystemKey(oldSecret);
	const newSystemKey = deriveSystemKey(config.secretKeyNew);

	// ユーザーソルトの一覧（ユーザー鍵スコープの再暗号化に使用）
	const userSalts = new Map<string, string>();
	for (const row of db.prepare("SELECT discord_id, salt FROM users").all() as {
		discord_id: string;
		salt: string;
	}[]) {
		userSalts.set(row.discord_id, row.salt);
	}

	let rotated = 0;
	const rotateAll = db.transaction(() => {
		for (const spec of ENCRYPTED_COLUMNS) {
			const [encCol, ivCol, tagCol] = spec.columns;
			const selectCols = [
				...spec.keyColumns,
				encCol,
				ivCol,
				tagCol,
				...(spec.userScopedBy ? [spec.userScopedBy] : []),
			];
			let rows: Record<string, string | null>[];
			try {
				rows = db
					.prepare(
						`SELECT ${[...new Set(selectCols)].join(", ")} FROM ${spec.table} WHERE ${encCol} IS NOT NULL AND ${encCol} != ''`,
					)
					.all() as Record<string, string | null>[];
			} catch {
				continue; // テーブル未作成（初回起動）の場合はスキップ
			}

			for (const row of rows) {
				const enc = row[encCol]!;
				const iv = row[ivCol]!;
				const tag = row[tagCol]!;
				let plaintext: string;
				let newEnc: { encrypted: string; iv: string; authTag: string };

				if (spec.userScopedBy) {
					const uid = row[spec.userScopedBy]!;
					const saltHex = userSalts.get(uid);
					if (!saltHex) continue;
					const oldUserKey = deriveUserKey(saltHex, oldSecret);
					const newUserKey = deriveUserKey(saltHex, config.secretKeyNew!);
					plaintext = decryptWithKey(oldUserKey, enc, iv, tag);
					newEnc = encryptWithKey(newUserKey, plaintext);
				} else {
					plaintext = decryptWithKey(oldSystemKey, enc, iv, tag);
					newEnc = encryptWithKey(newSystemKey, plaintext);
				}

				const where = spec.keyColumns.map((c) => `${c} = ?`).join(" AND ");
				db.prepare(
					`UPDATE ${spec.table} SET ${encCol} = ?, ${ivCol} = ?, ${tagCol} = ? WHERE ${where}`,
				).run(
					newEnc.encrypted,
					newEnc.iv,
					newEnc.authTag,
					...spec.keyColumns.map((c) => row[c]),
				);
				rotated++;
			}
		}
	});

	try {
		rotateAll();
	} catch (err) {
		console.error(
			"❌ YUUKA_ENCRYPTION_SECRET ローテーション中にエラーが発生しました。変更はロールバックされました:",
			err,
		);
		throw err;
	}

	console.log(
		`✅ YUUKA_ENCRYPTION_SECRET ローテーション完了（${rotated}件を再暗号化）。`,
	);
	console.log(
		"👉 次の手順: YUUKA_ENCRYPTION_SECRET_NEW の値を YUUKA_ENCRYPTION_SECRET に設定し、YUUKA_ENCRYPTION_SECRET_NEW を削除して再起動してください。",
	);

	// 以後このプロセスは新キーで動作する
	systemKey = newSystemKey;
	userKeyCache.clear();
	// config.secretKey を新キーに差し替える（プロセス内のみ）
	config.secretKey = config.secretKeyNew;
	config.secretKeyNew = "";
}
