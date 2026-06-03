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
