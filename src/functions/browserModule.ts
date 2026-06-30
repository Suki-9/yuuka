import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import * as browserFn from "./browserFunctions.js";

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

export const browserModule: FunctionModule = {
	declarations: browserDeclarations,
	handlers: browserHandlers,
};
