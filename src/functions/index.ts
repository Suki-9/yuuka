import fs from "node:fs";
import path from "node:path";
import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { config } from "../config.js";
import * as taskFn from "./taskFunctions.js";
import * as scheduleFn from "./scheduleFunctions.js";
import * as expenseFn from "./expenseFunctions.js";
import * as fileFn from "./fileFunctions.js";
import * as commandFn from "./commandFunctions.js";
import * as browserFn from "./browserFunctions.js";
import * as gitFn from "./gitFunctions.js";
import * as credentialFn from "./credentialFunctions.js";
import * as playbookFn from "./playbookFunctions.js";

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
  {
    name: "readCodeFile",
    description: "サンドボックス内のコードファイルの内容を読み込む。パスはプロジェクトルートからの相対パスで指定します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        filePath: { type: SchemaType.STRING, description: "読み込むファイルのパス (例: src/bot.ts)" },
      },
      required: ["filePath"],
    },
  },
  {
    name: "writeCodeFile",
    description: "サンドボックス内のコードファイルに新しい内容を書き込み、保存する。ディレクトリがない場合は自動作成されます。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        filePath: { type: SchemaType.STRING, description: "保存するファイルのパス (例: src/utils/mathHelper.ts)" },
        content: { type: SchemaType.STRING, description: "書き込む完全なソースコードまたはテキスト内容" },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "listCodeFiles",
    description: "サンドボックス内のファイルを再帰的に一覧取得する。特定のサブディレクトリのみ指定することも可能です。node_modules等は自動的に除外されます。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        dirPath: { type: SchemaType.STRING, description: "探索する基準のディレクトリパス (省略時はプロジェクトルート)" },
      },
    },
  },
  {
    name: "searchCodeFiles",
    description: "サンドボックス内の全ファイルからキーワード（テキスト）を検索する（簡易grep検索）。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "検索したい文字列・キーワード" },
        dirPath: { type: SchemaType.STRING, description: "検索対象の基準ディレクトリパス (省略時はプロジェクトルート)" },
      },
      required: ["query"],
    },
  },
  {
    name: "verifyCodeChanges",
    description: "ホワイトリストに登録された安全なシェルコマンドを実行して、コードのビルドやテスト検証を行う。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        command: {
          type: SchemaType.STRING,
          description: "実行するコマンド (許可: 'npm run build', 'npx tsc', 'npm test', 'git status', 'git diff', 'git diff --cached', 'git log -n 5', および安全な 'curl' コマンド。シェル制御記号を含むものは不可)",
        },
      },
      required: ["command"],
    },
  },

  // ── Git連携（自己拡張用） ──
  {
    name: "checkoutBranch",
    description: "Gitの新規開発用ブランチを作成、または既存ブランチへ切り替える。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        branchName: { type: SchemaType.STRING, description: "作成または切り替えるブランチ名 (例: feature/add-new-command)" },
      },
      required: ["branchName"],
    },
  },
  {
    name: "commitLocalChanges",
    description: "現在のすべてのコード変更（差分）をGitステージに追加し、ローカルにコミットする。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        commitMessage: { type: SchemaType.STRING, description: "コミットメッセージ (例: feat: 新しいサービスを追加)" },
      },
      required: ["commitMessage"],
    },
  },
  {
    name: "mergeBranch",
    description: "指定されたブランチを指定したターゲットブランチ（通常は 'main'）にローカルでマージする。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        branchName: { type: SchemaType.STRING, description: "マージするブランチ名 (例: feature/add-new-command)" },
        targetBranch: { type: SchemaType.STRING, description: "マージ先となるターゲットブランチ名 (デフォルト: main)" },
      },
      required: ["branchName"],
    },
  },
  {
    name: "pushChanges",
    description: "ローカルブランチの変更をリモートリポジトリ (origin) にプッシュ（保存）する（ローカルのSSH/認証情報を使用します）。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        branchName: { type: SchemaType.STRING, description: "プッシュするブランチ名 (例: feature/add-new-command)" },
      },
      required: ["branchName"],
    },
  },
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
    name: "reloadDynamicFunctions",
    description: "サンドボックス内でビルドされた動的プラグイン関数を再読み込み（ホットリロード）します。新しい関数を実装して 'npm run build' または 'npx tsc' でビルドした後にこの関数を呼び出すことで、即座に新しいツールが利用可能になります。",
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
  userId: string
): Promise<string> {
  // 自己拡張関連ツールのガード（サンドボックスが無効な場合は呼び出しエラーを返す）
  const sandboxTools = [
    "readCodeFile",
    "writeCodeFile",
    "listCodeFiles",
    "searchCodeFiles",
    "verifyCodeChanges",
    "checkoutBranch",
    "commitLocalChanges",
    "mergeBranch",
    "pushChanges",
    "reloadDynamicFunctions"
  ];
  if (sandboxTools.includes(functionName) && !isSandboxEnabled()) {
    return JSON.stringify({
      success: false,
      message: "エラー: 自己拡張機能（サンドボックス）は現在無効化されています。必要な設定を行ってください。"
    });
  }

  switch (functionName) {
    // タスク
    case "addTask":
      return taskFn.addTask(userId, args as Parameters<typeof taskFn.addTask>[1]);
    case "listTasks":
      return taskFn.listTasks(userId, args as Parameters<typeof taskFn.listTasks>[1]);
    case "completeTask":
      return taskFn.completeTask(userId, args as Parameters<typeof taskFn.completeTask>[1]);
    case "deleteTask":
      return taskFn.deleteTask(userId, args as Parameters<typeof taskFn.deleteTask>[1]);

    // 予定
    case "addSchedule":
      return await scheduleFn.addSchedule(userId, args as Parameters<typeof scheduleFn.addSchedule>[1]);
    case "listSchedules":
      return await scheduleFn.listSchedules(userId, args as Parameters<typeof scheduleFn.listSchedules>[1]);
    case "deleteSchedule":
      return await scheduleFn.deleteSchedule(
        userId,
        args as Parameters<typeof scheduleFn.deleteSchedule>[1]
      );

    // 家計
    case "addExpense":
      return expenseFn.addExpense(userId, args as Parameters<typeof expenseFn.addExpense>[1]);
    case "getMonthlySummary":
      return expenseFn.getMonthlySummary(
        userId,
        args as Parameters<typeof expenseFn.getMonthlySummary>[1]
      );
    case "getCategoryBreakdown":
      return expenseFn.getCategoryBreakdown(
        userId,
        args as Parameters<typeof expenseFn.getCategoryBreakdown>[1]
      );
    case "listRecentExpenses":
      return expenseFn.listRecentExpenses(
        userId,
        args as Parameters<typeof expenseFn.listRecentExpenses>[1]
      );

    // 自己開発・ファイル操作
    case "readCodeFile":
      return fileFn.readCodeFile(userId, args as Parameters<typeof fileFn.readCodeFile>[1]);
    case "writeCodeFile":
      return fileFn.writeCodeFile(userId, args as Parameters<typeof fileFn.writeCodeFile>[1]);
    case "listCodeFiles":
      return fileFn.listCodeFiles(userId, args as Parameters<typeof fileFn.listCodeFiles>[1]);
    case "searchCodeFiles":
      return fileFn.searchCodeFiles(userId, args as Parameters<typeof fileFn.searchCodeFiles>[1]);
    case "verifyCodeChanges":
      return commandFn.verifyCodeChanges(userId, args as Parameters<typeof commandFn.verifyCodeChanges>[1]);

    // Git連携
    case "checkoutBranch":
      return gitFn.checkoutBranch(userId, args as Parameters<typeof gitFn.checkoutBranch>[1]);
    case "commitLocalChanges":
      return gitFn.commitLocalChanges(userId, args as Parameters<typeof gitFn.commitLocalChanges>[1]);
    case "mergeBranch":
      return gitFn.mergeBranch(userId, args as Parameters<typeof gitFn.mergeBranch>[1]);
    case "pushChanges":
      return gitFn.pushChanges(userId, args as Parameters<typeof gitFn.pushChanges>[1]);
    
    // ヘッドレスブラウザ操作
    case "fetchDynamicPage":
      return await browserFn.fetchDynamicPage(userId, args as Parameters<typeof browserFn.fetchDynamicPage>[1]);
    case "takePageScreenshot":
      return await browserFn.takePageScreenshot(userId, args as Parameters<typeof browserFn.takePageScreenshot>[1]);
    case "searchWeb":
      return await browserFn.searchWeb(userId, args as Parameters<typeof browserFn.searchWeb>[1]);
    
    // 永続インタラクティブブラウザ操作
    case "browserInteractiveOpen":
      return await browserFn.browserInteractiveOpen(userId, args as Parameters<typeof browserFn.browserInteractiveOpen>[1]);
    case "browserInteractiveClick":
      return await browserFn.browserInteractiveClick(userId, args as Parameters<typeof browserFn.browserInteractiveClick>[1]);
    case "browserInteractiveType":
      return await browserFn.browserInteractiveType(userId, args as Parameters<typeof browserFn.browserInteractiveType>[1]);
    case "browserInteractiveWait":
      return await browserFn.browserInteractiveWait(userId, args as Parameters<typeof browserFn.browserInteractiveWait>[1]);
    case "browserInteractiveStatus":
      return await browserFn.browserInteractiveStatus(userId);
    case "browserInteractiveClose":
      return await browserFn.browserInteractiveClose(userId);

    // 資格情報
    case "getCredential":
      return await credentialFn.getCredential(userId, args as Parameters<typeof credentialFn.getCredential>[1]);
    case "listCredentials":
      return await credentialFn.listCredentials(userId, args as Parameters<typeof credentialFn.listCredentials>[1]);

    // 手順書（Playbook）自動化
    case "savePlaybook":
      return await playbookFn.savePlaybook(userId, args as Parameters<typeof playbookFn.savePlaybook>[1]);
    case "findPlaybooks":
      return await playbookFn.findPlaybooks(userId, args as Parameters<typeof playbookFn.findPlaybooks>[1]);

    // 動的プラグインのリロード
    case "reloadDynamicFunctions":
      try {
        await initializeDynamicFunctions(true);
        return JSON.stringify({
          success: true,
          message: "動的関数を正常にリロードしました。新しく追加された関数が利用可能です。",
          loadedFunctions: dynamicFunctionDeclarations.map(d => d.name)
        });
      } catch (err: any) {
        return JSON.stringify({ success: false, message: `リロード失敗: ${err.message}` });
      }

    default:
      // 動的ロードされた関数マップに存在すれば実行する
      if (dynamicDispatchMap.has(functionName)) {
        const fn = dynamicDispatchMap.get(functionName)!;
        return await fn(userId, args);
      }
      return JSON.stringify({ success: false, message: `不明な関数: ${functionName}` });
  }
}

// ─── 動的プラグインロード機構 ───────────────────────────────────────────

export const dynamicFunctionDeclarations: FunctionDeclaration[] = [];
const dynamicDispatchMap = new Map<string, (userId: string, args: any) => Promise<string> | string>();

/**
 * 自己拡張機能（サンドボックス）が有効に設定されているかどうかを判定する
 */
export function isSandboxEnabled(): boolean {
  if (!config.sandboxPath) return false;
  try {
    return fs.existsSync(config.sandboxPath) && fs.statSync(config.sandboxPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 全ての関数定義（静的＋動的ロードされたもの）を返す
 */
export function getAllFunctionDeclarations(): FunctionDeclaration[] {
  const allStatic = functionDeclarations;
  
  if (!isSandboxEnabled()) {
    // 自己拡張機能が無効な場合、自己拡張関連ツールを除外して返す
    const sandboxTools = [
      "readCodeFile",
      "writeCodeFile",
      "listCodeFiles",
      "searchCodeFiles",
      "verifyCodeChanges",
      "checkoutBranch",
      "commitLocalChanges",
      "mergeBranch",
      "pushChanges",
      "reloadDynamicFunctions"
    ];
    return allStatic.filter(decl => !sandboxTools.includes(decl.name));
  }

  return [...allStatic, ...dynamicFunctionDeclarations];
}

/**
 * サンドボックス内に動的追加された関数定義・ロジックをスキャンしてロードする
 */
export async function initializeDynamicFunctions(clearCache = false): Promise<void> {
  if (!isSandboxEnabled()) {
    console.log("[Dynamic Function] サンドボックスが無効または未設定のため、動的関数のロードをスキップします。");
    return;
  }

  const sandboxAbs = path.resolve(config.sandboxPath);
  const selfAbs = path.resolve(process.cwd());
  
  // 自分自身のリポジトリの場合は重複読み込み防止のためスキップ
  if (sandboxAbs === selfAbs) return;

  const distFunctionsDir = path.join(sandboxAbs, "dist", "functions");
  if (!fs.existsSync(distFunctionsDir)) {
    console.log(`[Dynamic Function] ${distFunctionsDir} が存在しないため、動的関数のロードをスキップします。`);
    return;
  }

  try {
    const files = fs.readdirSync(distFunctionsDir);
    const ignoreFiles = [
      "index.js",
      "taskFunctions.js",
      "scheduleFunctions.js",
      "expenseFunctions.js",
      "fileFunctions.js",
      "commandFunctions.js",
      "browserFunctions.js",
      "gitFunctions.js"
    ];

    if (clearCache) {
      dynamicFunctionDeclarations.length = 0;
      dynamicDispatchMap.clear();
    }

    for (const file of files) {
      if (file.endsWith(".js") && !ignoreFiles.includes(file)) {
        const fullPath = path.join(distFunctionsDir, file);
        const fileUrl = clearCache ? `file://${fullPath}?t=${Date.now()}` : `file://${fullPath}`;
        
        try {
          const module = await import(fileUrl);
          
          // 1. 宣言の登録 (規約: module.functionDeclarations 配列から取得)
          if (module.functionDeclarations && Array.isArray(module.functionDeclarations)) {
            for (const decl of module.functionDeclarations) {
              // 重複登録の防止
              if (dynamicFunctionDeclarations.some(d => d.name === decl.name)) {
                continue;
              }
              dynamicFunctionDeclarations.push(decl);
              
              // 2. 実行関数の登録
              const fnName = decl.name;
              if (typeof module[fnName] === "function") {
                dynamicDispatchMap.set(fnName, module[fnName]);
                console.log(`[Dynamic Function] Loaded function: ${fnName} from ${file} (clearCache=${clearCache})`);
              } else {
                console.warn(`[Dynamic Function] Function "${fnName}" is declared in ${file} but its execution function is not exported.`);
              }
            }
          }
        } catch (importErr) {
          console.error(`[Dynamic Function] Failed to import ${file}:`, importErr);
        }
      }
    }
  } catch (err) {
    console.error("[Dynamic Function] Failed to load dynamic functions:", err);
  }
}
