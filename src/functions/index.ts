import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import * as taskFn from "./taskFunctions.js";
import * as scheduleFn from "./scheduleFunctions.js";
import * as expenseFn from "./expenseFunctions.js";
import * as fileFn from "./fileFunctions.js";
import * as gitFn from "./gitFunctions.js";

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
          description: "実行するコマンド (許可: 'npm run build', 'npx tsc', 'npm test', 'git status', 'git diff', 'git diff --cached', 'git log -n 5')",
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
];


// ─── Function Dispatcher ───────────────────────────────────────────────

type FunctionArgs = Record<string, unknown>;

export async function dispatchFunction(
  functionName: string,
  args: FunctionArgs,
  userId: string
): Promise<string> {
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
      return fileFn.verifyCodeChanges(userId, args as Parameters<typeof fileFn.verifyCodeChanges>[1]);

    // Git連携
    case "checkoutBranch":
      return gitFn.checkoutBranch(userId, args as Parameters<typeof gitFn.checkoutBranch>[1]);
    case "commitLocalChanges":
      return gitFn.commitLocalChanges(userId, args as Parameters<typeof gitFn.commitLocalChanges>[1]);
    case "mergeBranch":
      return gitFn.mergeBranch(userId, args as Parameters<typeof gitFn.mergeBranch>[1]);
    case "pushChanges":
      return gitFn.pushChanges(userId, args as Parameters<typeof gitFn.pushChanges>[1]);

    default:
      return JSON.stringify({ success: false, message: `不明な関数: ${functionName}` });
  }
}
