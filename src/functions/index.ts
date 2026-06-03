import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import * as taskFn from "./taskFunctions.js";
import * as scheduleFn from "./scheduleFunctions.js";
import * as expenseFn from "./expenseFunctions.js";
import * as browserFn from "./browserFunctions.js";
import * as credentialFn from "./credentialFunctions.js";
import * as playbookFn from "./playbookFunctions.js";
import { buildRichContentEmbed } from "../utils/embeds.js";
import type { EmbedBuilder } from "discord.js";

// ─── Function Declarations for Gemini ──────────────────────────────────

export const functionDeclarations: FunctionDeclaration[] = [
  // ── タスク管理 ──
  {
    name: "addTask",
    description: "新しいタスク（ToDo）を追加する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: "タスクのタイトル" },
        description: { type: SchemaType.STRING, description: "タスクの詳細説明（任意）" },
        due_date: {
          type: SchemaType.STRING,
          description: "期限日 (YYYY-MM-DD形式、任意)",
        },
        priority: {
          type: SchemaType.NUMBER,
          description: "優先度 (0=低, 1=中, 2=高、デフォルト0)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "listTasks",
    description: "タスク一覧を取得する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        status: {
          type: SchemaType.STRING,
          description: "フィルタするステータス (pending=未完了, done=完了, all=全て、デフォルトpending)",
        },
      },
    },
  },
  {
    name: "completeTask",
    description: "タスクを完了にする",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        task_id: { type: SchemaType.NUMBER, description: "完了にするタスクのID" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "deleteTask",
    description: "タスクを削除する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        task_id: { type: SchemaType.NUMBER, description: "削除するタスクのID" },
      },
      required: ["task_id"],
    },
  },

  // ── 予定管理 ──
  {
    name: "addSchedule",
    description: "新しい予定・スケジュールを登録する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: "予定のタイトル" },
        start_at: {
          type: SchemaType.STRING,
          description: "開始日時 (ISO 8601形式、例: 2026-05-28T10:00:00)",
        },
        end_at: {
          type: SchemaType.STRING,
          description: "終了日時 (ISO 8601形式、任意)",
        },
        remind_before_minutes: {
          type: SchemaType.NUMBER,
          description: "何分前にリマインドするか (デフォルト30分)",
        },
        description: { type: SchemaType.STRING, description: "予定の詳細（任意）" },
        calendar_id: {
          type: SchemaType.STRING,
          description: "登録先GoogleカレンダーのID（任意。目的に最も適したカレンダーIDを選択し設定します）",
        },
        local_only: {
          type: SchemaType.BOOLEAN,
          description: "Googleカレンダーに同期せず、ボットのローカル通知のみに留めるか（簡易タイマーやリマインダーならtrueを設定します）",
        },
      },
      required: ["title", "start_at"],
    },
  },
  {
    name: "listSchedules",
    description: "今後の予定一覧を取得する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        days: {
          type: SchemaType.NUMBER,
          description: "何日先までの予定を表示するか (デフォルト7日)",
        },
      },
    },
  },
  {
    name: "deleteSchedule",
    description: "予定を削除する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        schedule_id: { type: SchemaType.NUMBER, description: "削除する予定のID" },
      },
      required: ["schedule_id"],
    },
  },

  // ── 家計管理 ──
  {
    name: "addExpense",
    description:
      "支出を家計簿に記録する。カテゴリは: 食費, 日用品, 交通費, 光熱費, 通信費, 医療費, 娯楽, 衣服, その他",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        amount: { type: SchemaType.NUMBER, description: "金額（円、整数）" },
        category: {
          type: SchemaType.STRING,
          description:
            "カテゴリ: 食費, 日用品, 交通費, 光熱費, 通信費, 医療費, 娯楽, 衣服, その他",
        },
        description: { type: SchemaType.STRING, description: "支出のメモ・説明（任意）" },
        date: {
          type: SchemaType.STRING,
          description: "支出日 (YYYY-MM-DD形式、デフォルト今日)",
        },
      },
      required: ["amount", "category"],
    },
  },
  {
    name: "getMonthlySummary",
    description: "月間の支出サマリーを取得する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: { type: SchemaType.NUMBER, description: "年 (デフォルト今年)" },
        month: { type: SchemaType.NUMBER, description: "月 (デフォルト今月)" },
      },
    },
  },
  {
    name: "getCategoryBreakdown",
    description: "月間のカテゴリ別支出内訳を取得する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: { type: SchemaType.NUMBER, description: "年 (デフォルト今年)" },
        month: { type: SchemaType.NUMBER, description: "月 (デフォルト今月)" },
      },
    },
  },
  {
    name: "listRecentExpenses",
    description: "直近の支出履歴を取得する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        count: { type: SchemaType.NUMBER, description: "取得件数 (デフォルト10件)" },
      },
    },
  },

  // ── 予算上限管理 ──
  {
    name: "getBudgetLimits",
    description: "カテゴリ別の月間予算上限の一覧を取得する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "setBudgetLimit",
    description: "指定カテゴリの月間予算上限を設定（追加・更新）する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        category: {
          type: SchemaType.STRING,
          description: "対象カテゴリ: 食費, 日用品, 交通費, 光熱費, 通信費, 医療費, 娯楽, 衣服, その他",
        },
        limit_amount: {
          type: SchemaType.NUMBER,
          description: "月間上限金額（円、整数）",
        },
      },
      required: ["category", "limit_amount"],
    },
  },
  {
    name: "deleteBudgetLimit",
    description: "指定カテゴリの月間予算上限を削除する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        category: {
          type: SchemaType.STRING,
          description: "削除するカテゴリ名",
        },
      },
      required: ["category"],
    },
  },

  // ── 支払い予定管理 ──
  {
    name: "listExpensePlans",
    description: "支払い予定の一覧を取得する。期限超過の予定も確認できる",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        include_paid: {
          type: SchemaType.BOOLEAN,
          description: "支払済みの予定も含めるか (デフォルト: false = 未払いのみ)",
        },
      },
    },
  },
  {
    name: "addExpensePlan",
    description: "将来の支払い予定（家賃・光熱費・サブスクなど）を登録する",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: "支払い予定のタイトル（例: 家賃、電気代）" },
        amount: { type: SchemaType.NUMBER, description: "支払予定金額（円、整数）" },
        category: {
          type: SchemaType.STRING,
          description: "カテゴリ: 食費, 日用品, 交通費, 光熱費, 通信費, 医療費, 娯楽, 衣服, その他",
        },
        planned_date: {
          type: SchemaType.STRING,
          description: "支払予定日 (YYYY-MM-DD形式)",
        },
        description: { type: SchemaType.STRING, description: "メモ・備考（任意）" },
      },
      required: ["title", "amount", "category", "planned_date"],
    },
  },
  {
    name: "payExpensePlan",
    description: "支払い予定を支払済みにする。家計簿に自動で記録される",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        plan_id: { type: SchemaType.NUMBER, description: "支払い予定のID (#番号)" },
      },
      required: ["plan_id"],
    },
  },
  {
    name: "deleteExpensePlan",
    description: "支払い予定を削除する（支払わずにキャンセルする場合）",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        plan_id: { type: SchemaType.NUMBER, description: "削除する支払い予定のID" },
      },
      required: ["plan_id"],
    },
  },

  // ── ヘッドレスブラウザ操作 ──
  {
    name: "fetchDynamicPage",
    description: "JavaScriptで動的に生成されるSPAなどのウェブページを開き、不要なタグ（スクリプト、スタイル、ナビゲーション、フッター、画像、メタデータ等）を完全に除去して超軽量化したHTMLを取得します（ヘッドレスブラウザを使用）。これにより、トークン消費を最小限に抑えつつ構造化データを正確に把握できます。",
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
    description: "指定されたURLのウェブページ全体のスクリーンショットを撮影し、画像としてサーバーに保存します（ヘッドレスブラウザを使用）。",
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
    description: "インターネットでキーワード検索を行い、関連するウェブページのタイトル、URL、説明（スニペット）の一覧を取得します。現在の天気、最新ニュース、事実確認年など、リアルタイムの情報を取得する最初のステップとして非常に有効です。必要に応じて、得られたURLから fetchDynamicPage を使って詳細なページ情報をさらに取得・巡回（クロール）し、複数回検索や巡回を繰り返して情報を比較精査することを推奨します。",
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
    description: "インタラクティブブラウザの永続セッションを開始または再利用し、指定されたURLを開きます。ログインや操作を行いたい特定のWebページの最初の手順として呼び出します。",
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
    description: "インタラクティブブラウザのアクティブなページ上で、指定された要素をクリックします。画面上の操作可能な要素には [ID: 数値] または [Button ID: 数値] のように一意の数値IDがマークダウン内に付与されているため、最優先でその数値ID（例: '3'）を selector 引数に直接指定してください。CSSセレクタやテキストでの指定も可能ですが、数値IDが最も確実で推奨されます。",
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
    description: "インタラクティブブラウザのアクティブなページ上の指定された入力フィールドにテキストを入力します。画面上の入力フィールドには [Input (text) ID: 数値] のように一意の数値IDがマークダウン内に付与されているため、最優先でその数値ID（例: '2'）を selector 引数に直接指定してください。CSSセレクタやプレースホルダー名での指定も可能ですが、数値IDが最も確実で推奨されます。",
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
    description: "インタラクティブブラウザのアクティブなページ上で、指定された時間（ミリ秒）待機するか、特定のCSSセレクタを持つ要素がDOM上に出現するまで待機します。",
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
    description: "現在のインタラクティブブラウザのアクティブな状態（現在のURL、タイトル、最新スクリーンショット画像パス、およびクリーンアップした最新マークダウンコンテンツ）を取得します。クリックやテキスト入力を行った後、画面の反応や遷移結果を確認するために必ず呼び出してください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "browserInteractiveClose",
    description: "インタラクティブブラウザの永続セッションを終了し、ブラウザを完全にクローズしてリソースを解放します。一連の操作代行がすべて完了した際に最後に呼び出します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "getCredential",
    description: "指定されたサービス（例: 'github', 'millennium-portal'）のユーザー名とパスワードを安全にロードして取得します。Webサイトへの自動ログインが必要な場合にのみ呼び出してください。取得したパスワードそのものを先生（ユーザー）とのチャットにそのまま出力してはいけません。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        service_name: {
          type: SchemaType.STRING,
          description: "サービスの名前（小文字の英数字、ハイフン推奨。例: 'github'）",
        },
      },
      required: ["service_name"],
    },
  },
  {
    name: "listCredentials",
    description: "現在登録されている資格情報のインデックス（サービス名とユーザー名）の一覧を取得します。どのようなログイン情報がすでに登録されているか、サービス名を確認したい場合にのみ呼び出してください。パスワードはここには含まれません。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
  {
    name: "savePlaybook",
    description: "AIが行った一連の操作手順（Playbook）に名前やキーワードを付与してMarkdownファイルとして永続的に保存（記憶）します。ユーザーから「今の操作手順を覚えておいて」「『〜〜』という名前で保存して」と指示された際に呼び出します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: {
          type: SchemaType.STRING,
          description: "手順書の英数字ファイル名 (例: 'example_login', 'tadaden_invoice')",
        },
        title: {
          type: SchemaType.STRING,
          description: "手順書の分かりやすい日本語タイトル (例: 'サンプルサイトのログインと請求書取得')",
        },
        keywords: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "次回検索時にヒットさせたい関連キーワードのリスト (例: ['サンプル', 'ログイン', '請求書', '電気代'])",
        },
        description: {
          type: SchemaType.STRING,
          description: "この手順書が何を行うものかの簡単な説明",
        },
        steps: {
          type: SchemaType.STRING,
          description: "Markdown形式の具体的な操作手順の各ステップ記述。使用する具体的なAPIツール名や判定ロジックを含めると効果的です。",
        },
      },
      required: ["name", "title", "keywords", "description", "steps"],
    },
  },
  // ── リッチコンテンツ表示 ──
  {
    name: "showRichContent",
    description: "天気・ニュース・株価・路線情報など、データを視覚的に整理してDiscordのEmbed（カード形式）で表示します。テキストだけで返すより読みやすく伝えたいデータがある場合に積極的に呼び出してください。このツールはEmbedをキューに積むだけで、返信テキストと一緒にDiscordへ送信されます。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        title: { type: SchemaType.STRING, description: "Embedのタイトル（例: '🌤️ 東京の今日の天気'）" },
        description: { type: SchemaType.STRING, description: "タイトル直下に表示する概要テキスト（任意）" },
        color: {
          type: SchemaType.STRING,
          description: "カラーテーマ: default（青紫）, success（緑）, warning（黄）, error（赤）, info（水色）, weather（空色）, news（オレンジ）, data（紫）",
        },
        fields: {
          type: SchemaType.ARRAY,
          description: "表示するフィールドの配列",
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

  {
    name: "findPlaybooks",
    description: "登録されているすべての自動化手順書（Playbook）の一覧、またはキーワード部分一致に関連する手順書とその中身の詳細を検索して取得します。ユーザーからブラウザ自動化や何らかの操作自動化を指示された際、すでに対応する手順書が登録されていないか確認する目的で最初に呼び出します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "検索したいキーワードや部分一致の文字列 (例: 'ログイン', 'でんき')。省略した場合はすべての手順書一覧を返します。",
        },
      },
    },
  },
];


// ─── Function Dispatcher ───────────────────────────────────────────────

type FunctionArgs = Record<string, unknown>;

export async function dispatchFunction(
  functionName: string,
  args: FunctionArgs,
  botId: string,
  embeds: EmbedBuilder[]
): Promise<string> {
  switch (functionName) {
    // タスク
    case "addTask":
      return taskFn.addTask(botId, args as Parameters<typeof taskFn.addTask>[1]);
    case "listTasks":
      return taskFn.listTasks(botId, args as Parameters<typeof taskFn.listTasks>[1]);
    case "completeTask":
      return taskFn.completeTask(botId, args as Parameters<typeof taskFn.completeTask>[1]);
    case "deleteTask":
      return taskFn.deleteTask(botId, args as Parameters<typeof taskFn.deleteTask>[1]);

    // 予定
    case "addSchedule":
      return await scheduleFn.addSchedule(botId, args as Parameters<typeof scheduleFn.addSchedule>[1]);
    case "listSchedules":
      return await scheduleFn.listSchedules(botId, args as Parameters<typeof scheduleFn.listSchedules>[1]);
    case "deleteSchedule":
      return await scheduleFn.deleteSchedule(
        botId,
        args as Parameters<typeof scheduleFn.deleteSchedule>[1]
      );

    // 家計
    case "addExpense":
      return expenseFn.addExpense(botId, args as Parameters<typeof expenseFn.addExpense>[1]);
    case "getMonthlySummary":
      return expenseFn.getMonthlySummary(
        botId,
        args as Parameters<typeof expenseFn.getMonthlySummary>[1]
      );
    case "getCategoryBreakdown":
      return expenseFn.getCategoryBreakdown(
        botId,
        args as Parameters<typeof expenseFn.getCategoryBreakdown>[1]
      );
    case "listRecentExpenses":
      return expenseFn.listRecentExpenses(
        botId,
        args as Parameters<typeof expenseFn.listRecentExpenses>[1]
      );

    // 予算上限
    case "getBudgetLimits":
      return expenseFn.getBudgetLimits(botId);
    case "setBudgetLimit":
      return expenseFn.setBudgetLimit(botId, args as Parameters<typeof expenseFn.setBudgetLimit>[1]);
    case "deleteBudgetLimit":
      return expenseFn.deleteBudgetLimit(botId, args as Parameters<typeof expenseFn.deleteBudgetLimit>[1]);

    // 支払い予定
    case "listExpensePlans":
      return expenseFn.listExpensePlans(botId, args as Parameters<typeof expenseFn.listExpensePlans>[1]);
    case "addExpensePlan":
      return expenseFn.addExpensePlan(botId, args as Parameters<typeof expenseFn.addExpensePlan>[1]);
    case "payExpensePlan":
      return expenseFn.payExpensePlan(botId, args as Parameters<typeof expenseFn.payExpensePlan>[1]);
    case "deleteExpensePlan":
      return expenseFn.deleteExpensePlan(botId, args as Parameters<typeof expenseFn.deleteExpensePlan>[1]);

    // ヘッドレスブラウザ操作
    case "fetchDynamicPage":
      return await browserFn.fetchDynamicPage(botId, args as Parameters<typeof browserFn.fetchDynamicPage>[1]);
    case "takePageScreenshot":
      return await browserFn.takePageScreenshot(botId, args as Parameters<typeof browserFn.takePageScreenshot>[1]);
    case "searchWeb":
      return await browserFn.searchWeb(botId, args as Parameters<typeof browserFn.searchWeb>[1]);
    
    // 永続インタラクティブブラウザ操作
    case "browserInteractiveOpen":
      return await browserFn.browserInteractiveOpen(botId, args as Parameters<typeof browserFn.browserInteractiveOpen>[1]);
    case "browserInteractiveClick":
      return await browserFn.browserInteractiveClick(botId, args as Parameters<typeof browserFn.browserInteractiveClick>[1]);
    case "browserInteractiveType":
      return await browserFn.browserInteractiveType(botId, args as Parameters<typeof browserFn.browserInteractiveType>[1]);
    case "browserInteractiveWait":
      return await browserFn.browserInteractiveWait(botId, args as Parameters<typeof browserFn.browserInteractiveWait>[1]);
    case "browserInteractiveStatus":
      return await browserFn.browserInteractiveStatus(botId);
    case "browserInteractiveClose":
      return await browserFn.browserInteractiveClose(botId);

    // 資格情報
    case "getCredential":
      return await credentialFn.getCredential(botId, args as Parameters<typeof credentialFn.getCredential>[1]);
    case "listCredentials":
      return await credentialFn.listCredentials(botId, args as Parameters<typeof credentialFn.listCredentials>[1]);

    // 手順書（Playbook）自動化
    case "savePlaybook":
      return await playbookFn.savePlaybook(botId, args as Parameters<typeof playbookFn.savePlaybook>[1]);
    case "findPlaybooks":
      return await playbookFn.findPlaybooks(botId, args as Parameters<typeof playbookFn.findPlaybooks>[1]);

    // リッチコンテンツEmbed表示
    case "showRichContent": {
      const data = args as {
        title: string;
        description?: string;
        color?: string;
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
        footer?: string;
      };
      embeds.push(buildRichContentEmbed(data));
      return JSON.stringify({ success: true });
    }

    default:
      return JSON.stringify({ success: false, message: `不明な関数: ${functionName}` });
  }
}

/**
 * 全ての関数定義を返す
 */
export function getAllFunctionDeclarations(): FunctionDeclaration[] {
  return functionDeclarations;
}
