import type { BotCapability } from "../services/botCapabilities.js";
import type { FunctionModule } from "../types/contracts.js";
import {
	botGuildMemoryFunctions,
	botMemberFunctions,
	botPersonalNoteFunctions,
} from "./botAssistantFunctions.js";
import { briefingFunctions } from "./briefingFunctions.js";
import { browserModule } from "./browserModule.js";
import { chartFunctions } from "./chartFunctions.js";
import { clipboardFunctions } from "./clipboardFunctions.js";
import { contactFunctions } from "./contactFunctions.js";
import { conversationFunctions } from "./conversationFunctions.js";
import { credentialFunctions } from "./credentialFunctions.js";
import { financeFunctions } from "./financeFunctions.js";
import { noteFunctions } from "./noteFunctions.js";
import { playbookFunctions } from "./playbookFunctions.js";
import { reminderFunctions } from "./reminderFunctions.js";
import { richContentModule } from "./richContentModule.js";
import { scheduleFunctions } from "./scheduleFunctions.js";
import { todoFunctions } from "./todoFunctions.js";

// ─── 機能モジュールカタログ（function_modularization.md §3.2） ───────────────
//
// Bot属性（bot_attributes_requirements.md §3.2 / §4.2）: 各モジュールを対応する
// ケーパビリティへマップし、Botが保持しないケーパビリティのモジュールは
// declarations / dispatch の両方から除外する（LLMに宣言自体を見せない）。
// 配列順は従来の BASE_MODULES と同一に保ち、秘書プリセットでは現行と完全一致させる。
//
// 各エントリには永続化キー `id` とUI表示用メタを付与する。`id` は bots.enabled_modules
// に保存されるため**リネーム禁止**（変更時はエイリアス表を別途用意すること）。
// `selectable: false`（core 等）は常時有効・ユーザー選択不可で、enabled_modules の影響を受けない。

/** 機能モジュールのカタログエントリ（モジュール参照 + UI/永続化メタ） */
export interface ModuleCatalogEntry {
	/** 永続化キー（bots.enabled_modules に保存。リネーム禁止） */
	id: string;
	module: FunctionModule;
	cap: "core" | BotCapability;
	/** UI表示名 */
	label: string;
	/** UI説明文 */
	description: string;
	/** false = 常時有効・選択不可（core 等。UIに出さず enabled_modules で無効化できない） */
	selectable: boolean;
	/** 管理UIサイドバーの対応タブ（data-tab値）。無効化時にそのタブを隠す。無い場合は省略 */
	settingsKey?: string;
}

const MODULE_CATALOG: ModuleCatalogEntry[] = [
	{
		id: "todo",
		module: todoFunctions,
		cap: "secretary",
		label: "ToDo・タスク管理",
		description: "タスクの登録・タグ・優先度・ルーチン管理",
		selectable: true,
		settingsKey: "tasks",
	},
	{
		id: "schedule",
		module: scheduleFunctions,
		cap: "secretary",
		label: "スケジュール",
		description: "予定の管理（Googleカレンダー連携）",
		selectable: true,
		settingsKey: "schedules",
	},
	{
		id: "reminder",
		module: reminderFunctions,
		cap: "secretary",
		label: "リマインダー",
		description: "通知のスケジュール・お知らせ",
		selectable: true,
		settingsKey: "reminders",
	},
	{
		id: "finance",
		module: financeFunctions,
		cap: "secretary",
		label: "家計・支出管理",
		description: "支出の記録・集計・予算管理",
		selectable: true,
		settingsKey: "expenses",
	},
	{
		id: "browser",
		module: browserModule,
		cap: "secretary",
		label: "ブラウザ操作・Web検索",
		description: "Web検索・ページ取得・ブラウザ自動操作",
		selectable: true,
	},
	{
		id: "credential",
		module: credentialFunctions,
		cap: "secretary",
		label: "認証情報の保管",
		description: "ログイン情報の暗号化保存・管理",
		selectable: true,
	},
	{
		id: "playbook",
		module: playbookFunctions,
		cap: "secretary",
		label: "プレイブック・自動化",
		description: "定型ワークフロー・自動化スクリプト",
		selectable: true,
		settingsKey: "playbooks",
	},
	{
		id: "note",
		module: noteFunctions,
		cap: "memory",
		label: "個人メモ",
		description: "メモの記録・参照",
		selectable: true,
		settingsKey: "personal",
	},
	{
		id: "clipboard",
		module: clipboardFunctions,
		cap: "secretary",
		label: "クリップボード共有",
		description: "テキストの一時共有",
		selectable: true,
	},
	{
		id: "contact",
		module: contactFunctions,
		cap: "secretary",
		label: "連絡先",
		description: "連絡先の管理",
		selectable: true,
	},
	{
		id: "conversation",
		module: conversationFunctions,
		cap: "memory",
		label: "会話履歴・記憶検索",
		description: "過去の会話の検索・記憶",
		selectable: true,
	},
	{
		id: "briefing",
		module: briefingFunctions,
		cap: "secretary",
		label: "朝刊・ニュース",
		description: "ニュース・RSS取得・朝刊",
		selectable: true,
	},
	{
		id: "chart",
		module: chartFunctions,
		cap: "secretary",
		label: "グラフ生成",
		description: "数値データのグラフ可視化",
		selectable: true,
	},
	{
		id: "richContent",
		module: richContentModule,
		cap: "core",
		label: "リッチ返信",
		description: "Embedカードによる装飾返信（常時有効）",
		selectable: false,
	},
];

/** モジュールIDからカタログエントリを引く（順序は MODULE_CATALOG と同一） */
const MODULE_BY_ID: ReadonlyMap<string, ModuleCatalogEntry> = new Map(
	MODULE_CATALOG.map((e) => [e.id, e]),
);

/**
 * UI/API用: 選択可能（selectable）なモジュールのメタ情報一覧（モジュール参照は含めない）。
 * cap で絞り込みたい場合は呼び出し側でフィルタする。
 */
export function listSelectableModules(): Array<
	Pick<
		ModuleCatalogEntry,
		"id" | "cap" | "label" | "description" | "settingsKey"
	>
> {
	return MODULE_CATALOG.filter((e) => e.selectable).map(
		({ id, cap, label, description, settingsKey }) => ({
			id,
			cap,
			label,
			description,
			settingsKey,
		}),
	);
}

/** 指定IDが選択可能なモジュールとして存在するか（API入力検証用） */
export function isKnownSelectableModule(id: string): boolean {
	return MODULE_BY_ID.get(id)?.selectable === true;
}

/**
 * 静的な FunctionModule 群を返す（秘書相当のフルセット。後方互換用）。
 * gemini.ts はこれに加えて MCP動的モジュール（getMcpFunctionModuleForBot）をマージし、
 * functions/registry.ts の buildFunctionRegistry でレジストリを構築する。
 */
export function getBaseFunctionModules(): FunctionModule[] {
	return MODULE_CATALOG.map((entry) => entry.module);
}

/**
 * Botのケーパビリティと有効モジュール選択に応じた静的 FunctionModule 群を返す（秘書系の対話パス用）。
 * core（selectable=false）は全Bot必須のため常に含める。mcp は動的モジュールのため呼び出し側でマージする。
 *
 * @param caps Botが保持するケーパビリティ集合
 * @param enabledModules 有効モジュールIDの集合。null/undefined = 全モジュール有効（後方互換・既存Bot）
 */
export function getFunctionModulesForCapabilities(
	caps: ReadonlySet<string>,
	enabledModules?: ReadonlySet<string> | null,
): FunctionModule[] {
	return MODULE_CATALOG.filter((entry) => {
		if (entry.cap !== "core" && !caps.has(entry.cap)) return false;
		// selectable=false（core等）は常に有効。enabledModules 未指定なら全有効。
		if (!entry.selectable || enabledModules == null) return true;
		return enabledModules.has(entry.id);
	}).map((entry) => entry.module);
}

/**
 * 汎用モード（MCPアシスタント）の静的 FunctionModule 群を返す。
 * 秘書系モジュールは一切含めず、ギルド会話では core にメンバー管理を含める（要件 §4.3.1 / §4.3.3）。
 * @param scope "guild" = 許可ギルド内の会話 / "dm" = owner との動作確認DM
 */
export function getGuildAssistantFunctionModules(
	scope: "guild" | "dm",
	caps: ReadonlySet<string>,
): FunctionModule[] {
	const modules: FunctionModule[] = [richContentModule]; // core: リッチ返信
	if (scope === "guild") {
		modules.push(botMemberFunctions); // core: 利用メンバー管理（要件 §4.3.3）
	}
	if (caps.has("memory")) {
		modules.push(botPersonalNoteFunctions); // memory: 個人ノート（bot × ユーザー）
		if (scope === "guild") {
			modules.push(botGuildMemoryFunctions); // memory: 共有ノート + ギルド会話検索
		}
	}
	return modules;
}
