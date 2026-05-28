import { getDb } from "./database.js";

export interface Expense {
  id: number;
  user_id: string;
  amount: number;
  category: string;
  description: string | null;
  date: string;
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
  userId: string,
  amount: number,
  category: string,
  description?: string,
  date?: string,
  source: string = "manual"
): Expense {
  const db = getDb();
  const expenseDate = date ?? new Date().toISOString().slice(0, 10);
  const stmt = db.prepare(`
    INSERT INTO expenses (user_id, amount, category, description, date, source)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(userId, amount, category, description ?? null, expenseDate, source);
  return getExpenseById(result.lastInsertRowid as number)!;
}

export function getExpenseById(id: number): Expense | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as Expense | undefined;
}

export function getMonthlyTotal(userId: string, year?: number, month?: number): number {
  const db = getDb();
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, "0")}`;

  const row = db
    .prepare("SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE user_id = ? AND date LIKE ?")
    .get(userId, `${prefix}%`) as { total: number };
  return row.total;
}

export function getMonthlyCategoryBreakdown(
  userId: string,
  year?: number,
  month?: number
): CategoryTotal[] {
  const db = getDb();
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  const prefix = `${y}-${String(m).padStart(2, "0")}`;

  return db
    .prepare(
      `SELECT category, SUM(amount) as total, COUNT(*) as count 
       FROM expenses 
       WHERE user_id = ? AND date LIKE ?
       GROUP BY category 
       ORDER BY total DESC`
    )
    .all(userId, `${prefix}%`) as CategoryTotal[];
}

export function listRecentExpenses(userId: string, count: number = 10): Expense[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT ?")
    .all(userId, count) as Expense[];
}
