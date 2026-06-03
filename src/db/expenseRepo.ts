import { getDb } from "./database.js";

export interface Expense {
  id: number;
  bot_id: string;
  amount: number;
  category: string;
  description: string | null;
  date: string;
  time: string | null;
  source: string;
  created_at: string;
}

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}

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

export function addExpense(
  botId: string,
  amount: number,
  category: string,
  description?: string,
  date?: string,
  time?: string,
  source: string = "manual"
): Expense {
  const db = getDb();
  const now = new Date();
  const expenseDate = date ?? now.toISOString().slice(0, 10);
  
  const pad = (n: number) => n.toString().padStart(2, "0");
  const defaultTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const expenseTime = time ?? defaultTime;

  const stmt = db.prepare(`
    INSERT INTO expenses (bot_id, amount, category, description, date, time, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(botId, amount, category, description ?? null, expenseDate, expenseTime, source);
  return getExpenseById(result.lastInsertRowid as number)!;
}

export function getExpenseById(id: number): Expense | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as Expense | undefined;
}

export function getMonthlyTotal(botId: string, year?: number, month?: number): number {
  const db = getDb();
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, "0")}`;

  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE bot_id = ? AND date LIKE ?")
    .get(botId, `${prefix}%`) as { total: number };
  return row.total;
}

export function getMonthlyCategoryBreakdown(
  botId: string,
  year?: number,
  month?: number
): CategoryTotal[] {
  const db = getDb();
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, "0")}`;

  return db
    .prepare
    (
      `SELECT category, SUM(amount) as total, COUNT(*) as count 
       FROM expenses 
       WHERE bot_id = ? AND date LIKE ?
       GROUP BY category 
       ORDER BY total DESC`
    )
    .all(botId, `${prefix}%`) as CategoryTotal[];
}

export function listRecentExpenses(botId: string, count: number = 10): Expense[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM expenses WHERE bot_id = ? ORDER BY date DESC, created_at DESC LIMIT ?")
    .all(botId, count) as Expense[];
}

// ── 予算上限 ──

export interface BudgetLimit {
  category: string;
  limit_amount: number;
}

export function getBudgetLimits(botId: string): BudgetLimit[] {
  const db = getDb();
  return db
    .prepare("SELECT category, limit_amount FROM bot_budget_limits WHERE bot_id = ?")
    .all(botId) as BudgetLimit[];
}

export function upsertBudgetLimit(botId: string, category: string, limitAmount: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO bot_budget_limits (bot_id, category, limit_amount, updated_at)
    VALUES (?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(bot_id, category) DO UPDATE SET
      limit_amount = excluded.limit_amount,
      updated_at = datetime('now', 'localtime')
  `).run(botId, category, limitAmount);
}

export function deleteBudgetLimit(botId: string, category: string): void {
  const db = getDb();
  db.prepare("DELETE FROM bot_budget_limits WHERE bot_id = ? AND category = ?").run(botId, category);
}

// ── 支払い予定 ──

export interface ExpensePlan {
  id: number;
  bot_id: string;
  title: string;
  amount: number;
  category: string;
  description: string | null;
  planned_date: string;
  is_paid: number;
  paid_expense_id: number | null;
  created_at: string;
}

export function addExpensePlan(
  botId: string,
  title: string,
  amount: number,
  category: string,
  plannedDate: string,
  description?: string
): ExpensePlan {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO expense_plans (bot_id, title, amount, category, planned_date, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(botId, title, amount, category, plannedDate, description ?? null);
  return getExpensePlanById(result.lastInsertRowid as number)!;
}

export function getExpensePlanById(id: number): ExpensePlan | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM expense_plans WHERE id = ?").get(id) as ExpensePlan | undefined;
}

export function listExpensePlans(botId: string, includePaid = false): ExpensePlan[] {
  const db = getDb();
  if (includePaid) {
    return db
      .prepare("SELECT * FROM expense_plans WHERE bot_id = ? ORDER BY planned_date ASC, created_at DESC")
      .all(botId) as ExpensePlan[];
  }
  return db
    .prepare("SELECT * FROM expense_plans WHERE bot_id = ? AND is_paid = 0 ORDER BY planned_date ASC, created_at DESC")
    .all(botId) as ExpensePlan[];
}

export function markExpensePlanPaid(id: number, botId: string, paidExpenseId: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE expense_plans SET is_paid = 1, paid_expense_id = ?
    WHERE id = ? AND bot_id = ? AND is_paid = 0
  `).run(paidExpenseId, id, botId);
  return result.changes > 0;
}

export function deleteExpensePlan(id: number, botId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM expense_plans WHERE id = ? AND bot_id = ?").run(id, botId);
  return result.changes > 0;
}
