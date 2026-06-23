import { getBotById } from "../db/botRepo.js";
import { getDb } from "../db/database.js";
import {
	getSystemSetting,
	setSystemSetting,
} from "../db/systemSettingsRepo.js";

// ─── Bot属性（ケーパビリティ）解決サービス（bot_attributes_requirements.md §3, §4.1） ─
//
// Botインスタンス単位の capabilities（JSON配列）を解決・キャッシュする。
// メッセージ処理のホットパスに乗るためインメモリキャッシュとし、
// 属性変更時に invalidateBotCapabilitiesCache で無効化する（要件 §7）。

/** ケーパビリティの種類（要件 §3.2。core は全Bot必須の暗黙付与のためJSONに書かない） */
export type BotCapability = "persona" | "memory" | "mcp" | "secretary";

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
	"persona",
	"memory",
	"mcp",
	"secretary",
]);

/** プリセットの内部ID（要件 §3.3: 内部IDは固定、表示名のみ変更可能） */
export type BotPresetId = "secretary" | "mcp_assistant";

/** プリセット定義（要件 §3.3） */
export const BOT_PRESETS: Record<
	BotPresetId,
	{ capabilities: BotCapability[]; defaultDisplayName: string }
> = {
	secretary: {
		capabilities: ["persona", "memory", "mcp", "secretary"],
		defaultDisplayName: "パーソナル秘書",
	},
	mcp_assistant: {
		capabilities: ["persona", "memory", "mcp"],
		defaultDisplayName: "汎用モード",
	},
};

/** 秘書相当（既存Botのデフォルト）の capabilities JSON */
export const DEFAULT_CAPABILITIES_JSON = JSON.stringify(
	BOT_PRESETS.secretary.capabilities,
);

// ─── capabilities の解決とキャッシュ ─────────────────────────────────────────

const capabilitiesCache = new Map<string, Set<BotCapability>>();

/** capabilities JSON 文字列をパースする（不正値は秘書相当へフォールバック） */
export function parseCapabilities(
	json: string | null | undefined,
): Set<BotCapability> {
	try {
		const parsed = JSON.parse(json || DEFAULT_CAPABILITIES_JSON);
		if (Array.isArray(parsed)) {
			const caps = parsed
				.map(String)
				.filter((c) => KNOWN_CAPABILITIES.has(c)) as BotCapability[];
			return new Set(caps);
		}
	} catch {}
	return new Set(BOT_PRESETS.secretary.capabilities);
}

/**
 * BotのケーパビリティをDBから解決する（インメモリキャッシュ付き）。
 * 不明なBot ID（DB未登録の system_default 等）は秘書相当として扱い、既存動作を変えない。
 */
export function resolveBotCapabilities(botId: string): Set<BotCapability> {
	const cached = capabilitiesCache.get(botId);
	if (cached) return cached;

	const bot = getBotById(botId);
	const caps = bot
		? parseCapabilities(
				(bot as unknown as { capabilities?: string }).capabilities,
			)
		: new Set<BotCapability>(BOT_PRESETS.secretary.capabilities);
	capabilitiesCache.set(botId, caps);
	return caps;
}

/** 属性変更・Bot削除時にキャッシュを無効化する（botId 省略時は全件） */
export function invalidateBotCapabilitiesCache(botId?: string): void {
	if (botId) {
		capabilitiesCache.delete(botId);
	} else {
		capabilitiesCache.clear();
	}
}

/** Botが指定ケーパビリティを保持するか（core は常に true） */
export function botHasCapability(
	botId: string,
	cap: BotCapability | "core",
): boolean {
	if (cap === "core") return true;
	return resolveBotCapabilities(botId).has(cap);
}

/**
 * ギルド常駐の汎用モード（MCPアシスタント）として動作すべきBotか。
 * 第一弾では「secretary を持たない = 汎用モード」と判定する
 * （プリセットは2種のみ。将来の自由編集導入時はこの判定を見直す。要件 §3.1）。
 */
export function isGuildAssistantBot(botId: string): boolean {
	return !resolveBotCapabilities(botId).has("secretary");
}

/** capabilities からプリセットIDを逆引きする（UI表示用） */
export function presetIdForCapabilities(caps: Set<BotCapability>): BotPresetId {
	return caps.has("secretary") ? "secretary" : "mcp_assistant";
}

/** Botへプリセットを適用する（DB更新 + キャッシュ無効化。認可・監査は呼び出し側） */
export function applyBotPreset(botId: string, presetId: BotPresetId): boolean {
	const preset = BOT_PRESETS[presetId];
	if (!preset) return false;
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE bots SET capabilities = ?, updated_at = datetime('now', 'localtime') WHERE id = ?`,
		)
		.run(JSON.stringify(preset.capabilities), botId);
	invalidateBotCapabilitiesCache(botId);
	return result.changes > 0;
}

// ─── プリセット表示名（要件 §3.3: 管理ページから変更可能、既定値あり） ────────

function presetDisplayNameKey(presetId: BotPresetId): string {
	return `preset_display_name:${presetId}`;
}

export function getPresetDisplayName(presetId: BotPresetId): string {
	return getSystemSetting(
		presetDisplayNameKey(presetId),
		BOT_PRESETS[presetId].defaultDisplayName,
	);
}

export function setPresetDisplayName(
	presetId: BotPresetId,
	displayName: string,
): void {
	const name = displayName.trim() || BOT_PRESETS[presetId].defaultDisplayName;
	setSystemSetting(presetDisplayNameKey(presetId), name.slice(0, 50));
}

/** UI用: 全プリセットの { id, displayName, capabilities } 一覧 */
export function listPresets(): Array<{
	id: BotPresetId;
	displayName: string;
	capabilities: BotCapability[];
}> {
	return (Object.keys(BOT_PRESETS) as BotPresetId[]).map((id) => ({
		id,
		displayName: getPresetDisplayName(id),
		capabilities: BOT_PRESETS[id].capabilities,
	}));
}
