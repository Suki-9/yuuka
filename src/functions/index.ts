import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import * as browserFn from "./browserFunctions.js";
import { buildRichContentEmbed } from "../utils/embeds.js";

// ── 各機能モジュール（FunctionModule） ──
import { todoFunctions } from "./todoFunctions.js";
import { scheduleFunctions } from "./scheduleFunctions.js";
import { reminderFunctions } from "./reminderFunctions.js";
import { financeFunctions } from "./financeFunctions.js";
import { credentialFunctions } from "./credentialFunctions.js";
import { playbookFunctions } from "./playbookFunctions.js";
import { noteFunctions } from "./noteFunctions.js";
import { clipboardFunctions } from "./clipboardFunctions.js";
import { contactFunctions } from "./contactFunctions.js";
import { conversationFunctions } from "./conversationFunctions.js";
import { briefingFunctions } from "./briefingFunctions.js";
import { chartFunctions } from "./chartFunctions.js";

// ─── ブラウザ操作 FunctionModule（§3.5: 既存実装のアダプタ） ──────────────────
// browserFunctions.ts（既存・変更禁止）は (userId, args) 形式のため、
// ToolContext から userId を渡すアダプタとしてここで FunctionModule 化する。
// v2では ctx.userId（DiscordユーザーID）でブラウザセッションが分離される（§5.5）。

const browserDeclarations: FunctionDeclaration[] = [
  {
    name: "fetchDynamicPage",
    description:
      "JavaScriptで動的に生成されるSPAなどのウェブページを開き、不要なタグ（スクリプト、スタイル、ナビゲーション、フッター、画像、メタデータ等）を完全に除去して超軽量化したHTMLを取得します（ヘッドレスブラウザを使用）。これにより、トークン消費を最小限に抑えつつ構造化データを正確に把握できます。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: { type: SchemaType.STRING, description: "アクセスするウェブページのURL" },
      },
      required: ["url"],
    },
  },
  {
    name: "takePageScreenshot",
    description:
      "指定されたURLのウェブページ全体のスクリーンショットを撮影し、画像としてサーバーに保存します（ヘッドレスブラウザを使用）。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: { type: SchemaType.STRING, description: "スクリーンショットを撮影するウェブページのURL" },
      },
      required: ["url"],
    },
  },
  {
    name: "searchWeb",
    description:
      "インターネットでキーワード検索を行い、関連するウェブページのタイトル、URL、説明（スニペット）の一覧を取得します。現在の天気、最新ニュース、事実確認など、リアルタイムの情報を取得する最初のステップとして非常に有効です。必要に応じて、得られたURLから fetchDynamicPage を使って詳細なページ情報をさらに取得・巡回（クロール）し、複数回検索や巡回を繰り返して情報を比較精査することを推奨します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "検索に入力するキーワード（例: '東京 明日の天気', 'ブルーアーカイブ 最新ニュース'）" },
      },
      required: ["query"],
    },
  },
  {
    name: "browserInteractiveOpen",
    description:
      "インタラクティブブラウザの永続セッションを開始または再利用し、指定されたURLを開きます。ログインや操作を行いたい特定のWebページの最初の手順として呼び出します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        url: { type: SchemaType.STRING, description: "アクセスするウェブページのURL" },
      },
      required: ["url"],
    },
  },
  {
    name: "browserInteractiveClick",
    description:
      "インタラクティブブラウザのアクティブなページ上で、指定された要素をクリックします。画面上の操作可能な要素には [ID: 数値] または [Button ID: 数値] のように一意の数値IDがマークダウン内に付与されているため、最優先でその数値ID（例: '3'）を selector 引数に直接指定してください。CSSセレクタやテキストでの指定も可能ですが、数値IDが最も確実で推奨されます。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        selector: { type: SchemaType.STRING, description: "クリック対象の一意の数値ID（最推奨、例: '3'）、またはCSSセレクタ/要素内のテキスト" },
      },
      required: ["selector"],
    },
  },
  {
    name: "browserInteractiveType",
    description:
      "インタラクティブブラウザのアクティブなページ上の指定された入力フィールドにテキストを入力します。画面上の入力フィールドには [Input (text) ID: 数値] のように一意の数値IDがマークダウン内に付与されているため、最優先でその数値ID（例: '2'）を selector 引数に直接指定してください。CSSセレクタやプレースホルダー名での指定も可能ですが、数値IDが最も確実で推奨されます。※パスワードの入力には本関数を使わず、browserFillCredential を使用してください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        selector: { type: SchemaType.STRING, description: "入力対象の一意の数値ID（最推奨、例: '2'）、またはCSSセレクタ/プレースホルダー名/name属性の一部" },
        text: { type: SchemaType.STRING, description: "入力するテキスト内容" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "browserInteractiveWait",
    description:
      "インタラクティブブラウザのアクティブなページ上で、指定された時間（ミリ秒）待機するか、特定のCSSセレクタを持つ要素がDOM上に出現するまで待機します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        selector: { type: SchemaType.STRING, description: "出現を待つCSSセレクタ（任意）" },
        timeoutMs: { type: SchemaType.NUMBER, description: "待機時間（ミリ秒、デフォルト5000ms、任意）" },
      },
    },
  },
  {
    name: "browserInteractiveStatus",
    description:
      "現在のインタラクティブブラウザのアクティブな状態（現在のURL、タイトル、最新スクリーンショット画像パス、およびクリーンアップした最新マークダウンコンテンツ）を取得します。クリックやテキスト入力を行った後、画面の反応や遷移結果を確認するために必ず呼び出してください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "browserInteractiveClose",
    description:
      "インタラクティブブラウザの永続セッションを終了し、ブラウザを完全にクローズしてリソースを解放します。一連の操作代行がすべて完了した際に最後に呼び出します。",
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
    browserFn.browserInteractiveType(ctx.userId, args as { selector: string; text: string }),
  browserInteractiveWait: (ctx: ToolContext, args) =>
    browserFn.browserInteractiveWait(ctx.userId, args as { selector?: string; timeoutMs?: number }),
  browserInteractiveStatus: (ctx: ToolContext) => browserFn.browserInteractiveStatus(ctx.userId),
  browserInteractiveClose: (ctx: ToolContext) => browserFn.browserInteractiveClose(ctx.userId),
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
        "天気・ニュース・株価・路線情報・一覧データなどを視覚的に整理してDiscordのEmbed（色付きカード形式）で表示します。データの一覧・サマリ・確認プロンプト・エラー通知など、テキストだけで返すより読みやすく伝えたい場合に積極的に呼び出してください。このツールはEmbedをキューに積むだけで、返信テキストと一緒にDiscordへ送信されます。グラフ画像が有用な数値データは sendChart を使ってください。",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING, description: "Embedのタイトル（例: '🌤️ 東京の今日の天気'）" },
          description: { type: SchemaType.STRING, description: "タイトル直下に表示する概要テキスト（任意）" },
          color: {
            type: SchemaType.STRING,
            description:
              "カラーテーマ: default（ブルー・通常情報）, success（グリーン・完了）, warning（イエロー・注意）, error（レッド・失敗）, weather（スカイブルー・天気/朝報）, finance（ゴールド・家計/支払い）, task（パープル・タスク/スケジュール）, info（水色）, news（オレンジ）, data（紫）",
          },
          fields: {
            type: SchemaType.ARRAY,
            description: "表示するフィールドの配列（名前・値のペア、最大25件）",
            items: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING, description: "フィールドのラベル" },
                value: { type: SchemaType.STRING, description: "フィールドの値" },
                inline: { type: SchemaType.BOOLEAN, description: "横並び表示にするか（デフォルト: false）" },
              },
              required: ["name", "value"],
            },
          },
          footer: { type: SchemaType.STRING, description: "フッターに表示する補足テキスト（例: 'データ提供: 気象庁'）（任意）" },
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
          message: "ユーザー設定によりリッチ返信は無効です。内容はプレーンテキストで伝えてください。",
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
        return JSON.stringify({ success: false, message: "title は必須です。" });
      }
      ctx.embeds.push(buildRichContentEmbed(data));
      return JSON.stringify({ success: true, message: "Embedを返信に添付しました。本文では要点のみ簡潔に補足してください。" });
    },
  },
};

// ─── 静的モジュールの集約 ────────────────────────────────────────────────────

const BASE_MODULES: FunctionModule[] = [
  todoFunctions,
  scheduleFunctions,
  reminderFunctions,
  financeFunctions,
  browserModule,
  credentialFunctions,
  playbookFunctions,
  noteFunctions,
  clipboardFunctions,
  contactFunctions,
  conversationFunctions,
  briefingFunctions,
  chartFunctions,
  richContentModule,
];

/**
 * 静的な FunctionModule 群を返す。
 * gemini.ts はこれに加えて MCP動的モジュール（getMcpFunctionModuleForUser）をマージし、
 * functions/registry.ts の buildFunctionRegistry でレジストリを構築する。
 */
export function getBaseFunctionModules(): FunctionModule[] {
  return BASE_MODULES;
}
