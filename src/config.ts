import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseYaml } from "./utils/yamlParser.js";

// config.yaml の読み込みとパース
const CONFIG_PATH = path.resolve(process.cwd(), "config.yaml");
let parsedConfig: Record<string, string | string[]> = {};

if (fs.existsSync(CONFIG_PATH)) {
	try {
		const content = fs.readFileSync(CONFIG_PATH, "utf-8");
		parsedConfig = parseYaml(content);
	} catch (err) {
		console.error(
			"⚠️ config.yaml の読み込みに失敗しました。デフォルト設定または環境変数を使用します。:",
			err,
		);
	}
} else {
	console.warn("⚠️ config.yaml が見つかりません。環境変数を使用します。");
}

function getSetting(key: string, defaultValue: string = ""): string {
	const val = parsedConfig[key] ?? process.env[key] ?? defaultValue;
	if (Array.isArray(val)) {
		return val.join(",");
	}
	return val;
}

function getSettingArray(key: string, defaultValue: string[] = []): string[] {
	const val = parsedConfig[key] ?? process.env[key];
	if (!val) return defaultValue;
	if (Array.isArray(val)) {
		return val;
	}
	return val
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

function _requireSetting(key: string): string {
	const value = getSetting(key);
	if (!value) {
		throw new Error(
			`設定項目 "${key}" が定義されていません。config.yaml または環境変数を確認してください。`,
		);
	}
	return value;
}

/**
 * システム全体の設定（全ユーザー共有）
 * ユーザー別設定はDBから取得する（userRepo.ts参照）
 */
export const config = {
	/** データベースファイルのパス */
	dbPath: getSetting("DB_PATH", "./data/yuuka.db"),

	/**
	 * 保存時暗号化のマスターシークレット（§6.2）
	 * 環境変数 YUUKA_ENCRYPTION_SECRET で設定する（.env / systemd の Environment 等）。
	 * 後方互換のため SECRET_KEY と config.yaml も受け付けるが、
	 * config.yaml の空文字エントリが環境変数を隠さないよう環境変数を優先する。
	 * ローテーション中のみ書き換わるため mutable。
	 */
	secretKey:
		process.env.YUUKA_ENCRYPTION_SECRET ||
		process.env.SECRET_KEY ||
		getSetting("YUUKA_ENCRYPTION_SECRET", "") ||
		getSetting("SECRET_KEY", ""),

	/** YUUKA_ENCRYPTION_SECRET ローテーション用の新キー（設定されている場合、起動時に再暗号化が走る） */
	secretKeyNew:
		process.env.YUUKA_ENCRYPTION_SECRET_NEW ||
		process.env.SECRET_KEY_NEW ||
		getSetting("YUUKA_ENCRYPTION_SECRET_NEW", "") ||
		getSetting("SECRET_KEY_NEW", ""),

	/** 返信チェーン解決の最大遡り深度（§3.1.4 無限ループ防止） */
	replyChainMaxDepth: parseInt(getSetting("REPLY_CHAIN_MAX_DEPTH", "10"), 10),

	/** セッショントークンの有効期限（日数、§5.4.2） */
	sessionTtlDays: parseInt(getSetting("SESSION_TTL_DAYS", "7"), 10),

	/** 初期Adminに昇格するDiscordユーザーID（§5.3.1。カンマ区切り、任意） */
	adminDiscordIds: getSettingArray("ADMIN_DISCORD_IDS"),

	/** Redis接続用URL */
	redisUrl: getSetting("REDIS_URL", "redis://127.0.0.1:6379"),

	/** リマインダーチェック間隔 (cron式) */
	reminderCron: getSetting("REMINDER_CRON", "* * * * *"),

	/** 管理画面サーバーのポート */
	port: parseInt(getSetting("PORT", "3000"), 10),

	/** 管理画面のバインドホスト (セキュリティのためデフォルトはローカルホスト) */
	host: getSetting("HOST", "127.0.0.1"),

	/**
	 * 信頼するリバースプロキシのIP（カンマ区切り、任意）。
	 * 設定されている場合のみ、直前のpeerがこのリストに含まれるリクエストの
	 * X-Forwarded-For 最右要素をクライアントIPとして採用する（ログインレート制限等）。
	 * 未設定時は socket.remoteAddress のみを信頼する。
	 */
	trustedProxies: getSettingArray("TRUSTED_PROXIES"),

	/** 招待コード一覧（起動時にDBに投入される） */
	inviteCodes: getSettingArray("INVITE_CODES"),

	/** Google OAuth Client ID (システムデフォルト) */
	googleClientId: getSetting("GOOGLE_CLIENT_ID", ""),

	/** Google OAuth Client Secret (システムデフォルト) */
	googleClientSecret: getSetting("GOOGLE_CLIENT_SECRET", ""),

	/** 外部公開用ベースURL */
	baseUrl: getSetting("BASE_URL", ""),

	/** 一般公開のプライバシーポリシーURL */
	privacyPolicyUrl: getSetting("PRIVACY_POLICY_URL", ""),

	/** 一般公開の利用規約URL */
	termsUrl: getSetting("TERMS_URL", ""),

	/** Google Search Console 所有権確認トークン */
	googleSiteVerification: getSetting("GOOGLE_SITE_VERIFICATION", ""),

	// ─── シナプス認知アーキテクチャ（v3 / schema v10）のチューニング設定 ──────────────
	// R0/R1 のコンポーネント（ツール実績記録・Rust エンジン・シナプス抽出・L2 想起・
	// メトリクス）は常時有効。エンジンはバイナリ(dist/bin/yuuka-synapse 等)があれば起動し、
	// 不在・未起動・タイムアウト時のみ現行挙動（直近15件の生注入）へ自動デグレードする。

	/** R1: L2 想起(1st Hop KNN)の取得件数。 */
	synapseRecallK: parseInt(getSetting("SYNAPSE_RECALL_K", "5"), 10),

	// ─── ターン処理プランナー / 重い処理の非同期化（常時有効） ──────────────

	/** プランナー用モデル（未指定なら本体と同じモデルを使う）。 */
	planModel: getSetting("PLAN_MODEL", ""),

	/** 非同期化の閾値（ms）。プラン推定ウェイトがこれ以上なら一時応答→非同期実行へ。 */
	heavyWeightThresholdMs: parseInt(
		getSetting("HEAVY_WEIGHT_THRESHOLD_MS", "8000"),
		10,
	),

	/** 実行時エスカレーション: ループ経過時間がこれ以上なら実行中でも一時応答を出す（ms）。 */
	heavyRuntimeMs: parseInt(getSetting("HEAVY_RUNTIME_MS", "12000"), 10),
};
