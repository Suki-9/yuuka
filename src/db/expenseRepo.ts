import { getDb } from "./database.js";

// ─── 家計 リポジトリ（§3.4） ─────────────────────────────────────────────────
//
// expenses / budget_limits テーブル（スキーマ定義は db/migrations.ts が唯一の定義元）の
// リポジトリ。v2 で bot_id スコープから user_id (DiscordユーザーID) スコープへ移行し、
// 収入（type='income'）と memo 列に対応した。
// データ分離の原則: 全クエリは user_id を WHERE 必須条件とする。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

/** 収支区分（§3.4.4） */
export type ExpenseType = "income" | "expense";

/** expenses テーブルの1レコード */
export interface ExpenseRecord {
  id: number;
  user_id: string;
  bot_id: string;
  type: ExpenseType;
  amount: number;
  category: string;
  memo: string | null;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:MM:SS'（任意） */
  time: string | null;
  /** 'manual' | 'receipt_ocr' */
  source: string;
  created_at: string;
}

/** 旧名との互換エイリアス */
export type Expense = ExpenseRecord;

/** カテゴリ別集計（getMonthlyCategoryBreakdown の戻り値） */
export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}

/** 月次推移の1点（getMonthlyTrend の戻り値） */
export interface MonthlyTrendPoint {
  /** 'YYYY-MM' */
  month: string;
  income: number;
  expense: number;
}

/** 支出カテゴリ（既存9カテゴリを維持） */
export const CATEGORIES = [
  "食費",
  "日用品",
  "交通費",
  "光熱費",
  "通信費",
  "医療費",
  "娯楽",
  "衣服",
  "その他",
] as const;

export type Category = (typeof CATEGORIES)[number];

// ─── ヘルパー ────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 集計対象月の 'YYYY-MM' プレフィックスを返す（省略時は当月） */
function monthPrefix(year?: number, month?: number): string {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  return `${y}-${pad2(m)}`;
}

// ─── 収支記録（§3.4.1: 収支手動入力・レシート自動記帳） ─────────────────────

/**
 * 収支を記録する（§3.4.4）。
 * @param type 'expense'（支出、既定） | 'income'（収入）
 * @param source 'manual'（既定） | 'receipt_ocr'（レシートOCR経由）
 */
export function addExpense(
  userId: string,
  botId: string,
  amount: number,
  category: string,
  memo?: string,
  date?: string,
  time?: string,
  source: string = "manual",
  type: ExpenseType = "expense"
): ExpenseRecord {
  const db = getDb();
  const now = new Date();
  const expenseDate =
    date ?? `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const expenseTime =
    time ?? `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  const result = db
    .prepare(
      `INSERT INTO expenses (user_id, bot_id, type, amount, category, memo, date, time, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, botId, type, amount, category, memo ?? null, expenseDate, expenseTime, source);
  return getExpenseById(userId, botId, result.lastInsertRowid as number)!;
}

/** ID指定で1件取得する（本人の記録のみ） */
export function getExpenseById(
  userId: string,
  botId: string,
  id: number
): ExpenseRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM expenses WHERE user_id = ? AND bot_id = ? AND id = ?")
    .get(userId, botId, id) as ExpenseRecord | undefined;
}

/** 直近の収支記録を新しい順に取得する（type 指定で収入/支出のみに絞り込み可） */
export function listRecentExpenses(
  userId: string,
  botId: string,
  count: number = 10,
  type?: ExpenseType
): ExpenseRecord[] {
  const db = getDb();
  if (type) {
    return db
      .prepare(
        `SELECT * FROM expenses WHERE user_id = ? AND bot_id = ? AND type = ?
         ORDER BY date DESC, created_at DESC LIMIT ?`
      )
      .all(userId, botId, type, count) as ExpenseRecord[];
  }
  return db
    .prepare(
      "SELECT * FROM expenses WHERE user_id = ? AND bot_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    )
    .all(userId, botId, count) as ExpenseRecord[];
}

// ─── 月次集計（§3.4.1: 収支一覧・集計） ─────────────────────────────────────

/** 指定月の合計金額を取得する（type 既定は支出。省略時は当月） */
export function getMonthlyTotal(
  userId: string,
  botId: string,
  year?: number,
  month?: number,
  type: ExpenseType = "expense"
): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
       WHERE user_id = ? AND bot_id = ? AND type = ? AND date LIKE ?`
    )
    .get(userId, botId, type, `${monthPrefix(year, month)}%`) as { total: number };
  return row.total;
}

/** 指定月の収入合計を取得する（省略時は当月） */
export function getMonthlyIncomeTotal(
  userId: string,
  botId: string,
  year?: number,
  month?: number
): number {
  return getMonthlyTotal(userId, botId, year, month, "income");
}

/** 指定月のカテゴリ別集計を金額の大きい順に取得する（type 既定は支出。省略時は当月） */
export function getMonthlyCategoryBreakdown(
  userId: string,
  botId: string,
  year?: number,
  month?: number,
  type: ExpenseType = "expense"
): CategoryTotal[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT category, SUM(amount) AS total, COUNT(*) AS count
       FROM expenses
       WHERE user_id = ? AND bot_id = ? AND type = ? AND date LIKE ?
       GROUP BY category
       ORDER BY total DESC`
    )
    .all(userId, botId, type, `${monthPrefix(year, month)}%`) as CategoryTotal[];
}

/**
 * 月次推移（収入・支出の月別合計）を古い月から順に取得する（グラフ・レポート用）。
 * 記録の無い月も income/expense = 0 で埋めて、常に months 件返す。
 * @param months 当月を含めて過去何ヶ月分を返すか（既定6ヶ月）
 */
export function getMonthlyTrend(
  userId: string,
  botId: string,
  months: number = 6
): MonthlyTrendPoint[] {
  const db = getDb();
  const n = Math.max(1, Math.floor(months));

  // 当月を含む過去 n ヶ月の 'YYYY-MM' ラベルを古い順に生成
  const now = new Date();
  const labels: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
  }

  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
              COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense
       FROM expenses
       WHERE user_id = ? AND bot_id = ? AND substr(date, 1, 7) >= ?
       GROUP BY month`
    )
    .all(userId, botId, labels[0]) as MonthlyTrendPoint[];

  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return labels.map((month) => byMonth.get(month) ?? { month, income: 0, expense: 0 });
}

// ─── 予算上限（§3.4.1: 予算管理） ───────────────────────────────────────────

export interface BudgetLimit {
  category: string;
  limit_amount: number;
}

/** 設定済みの月次予算上限を全カテゴリ分取得する */
export function getBudgetLimits(userId: string, botId: string): BudgetLimit[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT category, limit_amount FROM budget_limits WHERE user_id = ? AND bot_id = ? ORDER BY category"
    )
    .all(userId, botId) as BudgetLimit[];
}

/** 特定カテゴリの月次予算上限を取得する（未設定なら undefined） */
export function getBudgetLimit(
  userId: string,
  botId: string,
  category: string
): BudgetLimit | undefined {
  const db = getDb();
  return db
    .prepare(
      "SELECT category, limit_amount FROM budget_limits WHERE user_id = ? AND bot_id = ? AND category = ?"
    )
    .get(userId, botId, category) as BudgetLimit | undefined;
}

/** 月次予算上限を設定・更新する */
export function upsertBudgetLimit(
  userId: string,
  botId: string,
  category: string,
  limitAmount: number
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO budget_limits (user_id, bot_id, category, limit_amount, updated_at)
     VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
     ON CONFLICT(user_id, bot_id, category) DO UPDATE SET
       limit_amount = excluded.limit_amount,
       updated_at = datetime('now', 'localtime')`
  ).run(userId, botId, category, limitAmount);
}

/** 月次予算上限を削除する（削除できた場合 true） */
export function deleteBudgetLimit(userId: string, botId: string, category: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM budget_limits WHERE user_id = ? AND bot_id = ? AND category = ?")
    .run(userId, botId, category);
  return result.changes > 0;
}
