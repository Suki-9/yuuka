import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { BotCapability } from "../services/botCapabilities.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { buildRichContentEmbed } from "../utils/embeds.js";
import {
	botGuildMemoryFunctions,
	botMemberFunctions,
	botPersonalNoteFunctions,
} from "./botAssistantFunctions.js";
import { briefingFunctions } from "./briefingFunctions.js";
import * as browserFn from "./browserFunctions.js";
import { chartFunctions } from "./chartFunctions.js";
import { clipboardFunctions } from "./clipboardFunctions.js";
import { contactFunctions } from "./contactFunctions.js";
import { conversationFunctions } from "./conversationFunctions.js";
import { credentialFunctions } from "./credentialFunctions.js";
import { financeFunctions } from "./financeFunctions.js";
import { noteFunctions } from "./noteFunctions.js";
import { playbookFunctions } from "./playbookFunctions.js";
import { reminderFunctions } from "./reminderFunctions.js";
import { scheduleFunctions } from "./scheduleFunctions.js";
// ── 各機能モジュール（FunctionModule） ──
import { todoFunctions } from "./todoFunctions.js";

// ─── ブラウザ操作 FunctionModule（§3.5: 既存実装のアダプタ） ──────────────────
// browserFunctions.ts（既存・変更禁止）は (userId, args) 形式のため、
// ToolContext から userId を渡すアダプタとしてここで FunctionModule 化する。
// v2では ctx.userId（DiscordユーザーID）でブラウザセッションが分離される（§5.5）。

const browserDeclarations: FunctionDeclaration[] = [
	{
		name: "fetchDynamicPage",
		description:
			"指定したURLのページを開いて、本文だけを軽くまとめたHTMLを取り出す。\n" +
				"・JavaScriptで作られるページ（SPAなど）にも対応する。\n" +
				"・スクリプト・スタイル・ナビ・フッター・画像・メタ情報などの不要部分を取り除くので、中身を正確に読みやすい。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				url: {
					type: SchemaType.STRING,
					description: "開きたいウェブページのURL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "takePageScreenshot",
		description:
			"指定したURLのページ全体のスクリーンショットを撮り、画像としてサーバーに保存する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				url: {
					type: SchemaType.STRING,
					description: "スクリーンショットを撮るウェブページのURL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "searchWeb",
		description:
			"インターネットでキーワード検索し、関連ページのタイトル・URL・説明文の一覧を取り出す。\n" +
				"・例: 今の天気、最新ニュース、事実確認など、その時々の新しい情報を調べたい時の最初の一歩に使う。\n" +
				"・もっと詳しく知りたい時は、得られたURLを fetchDynamicPage に渡してページ本文を読む。\n" +
				"・検索とページ閲覧を何度か繰り返し、複数の情報を見比べて確かめるとよい。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				query: {
					type: SchemaType.STRING,
					description: "検索キーワード（例: '東京 明日の天気'）",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "browserInteractiveOpen",
		description:
			"操作用ブラウザのセッションを開始（または再利用）して、指定したURLを開く。\n" +
				"・ログインやページ操作を代行したい時の、いちばん最初の手順として呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				url: {
					type: SchemaType.STRING,
					description: "操作ブラウザで開きたいウェブページのURL",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "browserInteractiveClick",
		description:
			"操作用ブラウザで今開いているページ上の、指定した要素をクリックする。\n" +
				"・操作できる要素には [ID: 数値] や [Button ID: 数値] のように番号が振ってある。\n" +
				"・selector には、まずその数値ID（例: '3'）をそのまま入れるのが一番確実。\n" +
				"・CSSセレクタや要素内のテキストでも指定できるが、数値IDを優先する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				selector: {
					type: SchemaType.STRING,
					description:
						"クリックする要素の数値ID（最優先、例: '3'）。またはCSSセレクタ／要素内のテキストでも可",
				},
			},
			required: ["selector"],
		},
	},
	{
		name: "browserInteractiveType",
		description:
			"操作用ブラウザで今開いているページの、指定した入力欄に文字を打ち込む。\n" +
				"・入力欄には [Input (text) ID: 数値] のように番号が振ってある。\n" +
				"・selector には、まずその数値ID（例: '2'）をそのまま入れるのが一番確実。\n" +
				"・CSSセレクタやプレースホルダー名でも指定できるが、数値IDを優先する。\n" +
				"・パスワードの入力にはこれを使わず、必ず browserFillCredential を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				selector: {
					type: SchemaType.STRING,
					description:
						"文字を入れる入力欄の数値ID（最優先、例: '2'）。またはCSSセレクタ／プレースホルダー名／name属性の一部でも可",
				},
				text: { type: SchemaType.STRING, description: "打ち込む文字の内容" },
			},
			required: ["selector", "text"],
		},
	},
	{
		name: "browserInteractiveWait",
		description:
			"操作用ブラウザで今開いているページの読み込みや表示を待つ。\n" +
				"・指定したミリ秒だけ待つか、指定したCSSセレクタの要素が画面に出るまで待つ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				selector: {
					type: SchemaType.STRING,
					description: "出現を待ちたい要素のCSSセレクタ（省略可）",
				},
				timeoutMs: {
					type: SchemaType.NUMBER,
					description: "待つ時間（ミリ秒）。省略=5000ミリ秒（5秒）",
				},
			},
		},
	},
	{
		name: "browserInteractiveStatus",
		description:
			"操作用ブラウザの今の状態を取り出す（今のURL・タイトル・最新スクショ画像のパス・読みやすく整えた本文）。\n" +
				"・クリックや文字入力をした後は、画面がどう変わったか確認するために必ずこれを呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "browserInteractiveClose",
		description:
			"操作用ブラウザのセッションを終了し、ブラウザを完全に閉じてリソースを解放する。\n" +
				"・一連の操作の代行がすべて終わったら、最後にこれを呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
];

const browserHandlers: FunctionModule["handlers"] = {
	fetchDynamicPage: (ctx: ToolContext, args) =>
		browserFn.fetchDynamicPage(ctx.userId, args as { url: string }),
	takePageScreenshot: (ctx: ToolContext, args) =>
		browserFn.takePageScreenshot(ctx.userId, args as { url: string }),
	searchWeb: (ctx: ToolContext, args) =>
		browserFn.searchWeb(ctx.userId, args as { query: string }),
	browserInteractiveOpen: (ctx: ToolContext, args) =>
		browserFn.browserInteractiveOpen(ctx.userId, args as { url: string }),
	browserInteractiveClick: (ctx: ToolContext, args) =>
		browserFn.browserInteractiveClick(ctx.userId, args as { selector: string }),
	browserInteractiveType: (ctx: ToolContext, args) =>
		browserFn.browserInteractiveType(
			ctx.userId,
			args as { selector: string; text: string },
		),
	browserInteractiveWait: (ctx: ToolContext, args) =>
		browserFn.browserInteractiveWait(
			ctx.userId,
			args as { selector?: string; timeoutMs?: number },
		),
	browserInteractiveStatus: (ctx: ToolContext) =>
		browserFn.browserInteractiveStatus(ctx.userId),
	browserInteractiveClose: (ctx: ToolContext) =>
		browserFn.browserInteractiveClose(ctx.userId),
};

const browserModule: FunctionModule = {
	declarations: browserDeclarations,
	handlers: browserHandlers,
};

// ─── リッチコンテンツEmbed表示（§3.0.2） ─────────────────────────────────────

const richContentModule: FunctionModule = {
	declarations: [
		{
			name: "showRichContent",
			description:
				"天気・ニュース・株価・路線情報・一覧などを、色付きカード（DiscordのEmbed）に整えて見せる。\n" +
				"・一覧やまとめ、確認のお願い、エラー通知など、文章だけより見やすく伝えたい時に積極的に使う。\n" +
				"・このツールはカードを送信待ちに積むだけで、あとで返信の文章と一緒にDiscordへ届く。\n" +
				"・グラフ画像にした方がよい数値データ → 代わりに sendChart を使う。",
			parameters: {
				type: SchemaType.OBJECT,
				properties: {
					title: {
						type: SchemaType.STRING,
						description: "カードの見出し（例: '🌤️ 東京の今日の天気'）",
					},
					description: {
						type: SchemaType.STRING,
						description: "見出しのすぐ下に出す説明文（省略可）",
					},
					color: {
						type: SchemaType.STRING,
						description:
							"カードの色（内容に合わせて選ぶ）: default=青・ふつうの情報, success=緑・完了, warning=黄・注意, error=赤・失敗, weather=空色・天気/朝の知らせ, finance=金色・家計/支払い, task=紫・タスク/予定, info=水色, news=オレンジ, data=紫",
					},
					fields: {
						type: SchemaType.ARRAY,
						description: "カードに並べる項目の配列。各項目は名前と値のペア。最大25件まで",
						items: {
							type: SchemaType.OBJECT,
							properties: {
								name: {
									type: SchemaType.STRING,
									description: "項目の見出し（ラベル）",
								},
								value: {
									type: SchemaType.STRING,
									description: "フィールドの値",
								},
								inline: {
									type: SchemaType.BOOLEAN,
									description: "横並び表示にするか（デフォルト: false）",
								},
							},
							required: ["name", "value"],
						},
					},
					footer: {
						type: SchemaType.STRING,
						description:
							"フッターに表示する補足テキスト（例: 'データ提供: 気象庁'）（任意）",
					},
				},
				required: ["title"],
			},
		},
	],
	handlers: {
		showRichContent(ctx: ToolContext, args): string {
			// リッチ返信が無効の場合はEmbedを生成しない（§3.0.5）
			if (!ctx.richReplyEnabled) {
				return JSON.stringify({
					success: false,
					message:
						"ユーザー設定によりリッチ返信は無効です。内容はプレーンテキストで伝えてください。",
				});
			}
			const data = args as {
				title: string;
				description?: string;
				color?: string;
				fields?: Array<{ name: string; value: string; inline?: boolean }>;
				footer?: string;
			};
			if (!data.title) {
				return JSON.stringify({
					success: false,
					message: "title は必須です。",
				});
			}
			ctx.embeds.push(buildRichContentEmbed(data));
			return JSON.stringify({
				success: true,
				message:
					"Embedを返信に添付しました。本文では要点のみ簡潔に補足してください。",
			});
		},
	},
};

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
	{ id: "todo", module: todoFunctions, cap: "secretary", label: "ToDo・タスク管理", description: "タスクの登録・タグ・優先度・ルーチン管理", selectable: true, settingsKey: "tasks" },
	{ id: "schedule", module: scheduleFunctions, cap: "secretary", label: "スケジュール", description: "予定の管理（Googleカレンダー連携）", selectable: true, settingsKey: "schedules" },
	{ id: "reminder", module: reminderFunctions, cap: "secretary", label: "リマインダー", description: "通知のスケジュール・お知らせ", selectable: true, settingsKey: "reminders" },
	{ id: "finance", module: financeFunctions, cap: "secretary", label: "家計・支出管理", description: "支出の記録・集計・予算管理", selectable: true, settingsKey: "expenses" },
	{ id: "browser", module: browserModule, cap: "secretary", label: "ブラウザ操作・Web検索", description: "Web検索・ページ取得・ブラウザ自動操作", selectable: true },
	{ id: "credential", module: credentialFunctions, cap: "secretary", label: "認証情報の保管", description: "ログイン情報の暗号化保存・管理", selectable: true },
	{ id: "playbook", module: playbookFunctions, cap: "secretary", label: "プレイブック・自動化", description: "定型ワークフロー・自動化スクリプト", selectable: true, settingsKey: "playbooks" },
	{ id: "note", module: noteFunctions, cap: "memory", label: "個人メモ", description: "メモの記録・参照", selectable: true, settingsKey: "personal" },
	{ id: "clipboard", module: clipboardFunctions, cap: "secretary", label: "クリップボード共有", description: "テキストの一時共有", selectable: true },
	{ id: "contact", module: contactFunctions, cap: "secretary", label: "連絡先", description: "連絡先の管理", selectable: true },
	{ id: "conversation", module: conversationFunctions, cap: "memory", label: "会話履歴・記憶検索", description: "過去の会話の検索・記憶", selectable: true },
	{ id: "briefing", module: briefingFunctions, cap: "secretary", label: "朝刊・ニュース", description: "ニュース・RSS取得・朝刊", selectable: true },
	{ id: "chart", module: chartFunctions, cap: "secretary", label: "グラフ生成", description: "数値データのグラフ可視化", selectable: true },
	{ id: "richContent", module: richContentModule, cap: "core", label: "リッチ返信", description: "Embedカードによる装飾返信（常時有効）", selectable: false },
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
