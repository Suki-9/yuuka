import { getDb } from "./database.js";

export interface Task {
  id: number;
  bot_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export function addTask(
  botId: string,
  title: string,
  description?: string,
  dueDate?: string,
  priority?: number
): Task {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tasks (bot_id, title, description, due_date, priority)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(botId, title, description ?? null, dueDate ?? null, priority ?? 0);
  return getTaskById(result.lastInsertRowid as number)!;
}

export function listTasks(botId: string, status?: string): Task[] {
  const db = getDb();
  if (status && status !== "all") {
    return db
      .prepare("SELECT * FROM tasks WHERE bot_id = ? AND status = ? ORDER BY priority DESC, created_at DESC")
      .all(botId, status) as Task[];
  }
  return db
    .prepare("SELECT * FROM tasks WHERE bot_id = ? ORDER BY status ASC, priority DESC, created_at DESC")
    .all(botId) as Task[];
}

export function getTaskById(id: number): Task | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function completeTask(id: number, botId: string): Task | undefined {
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'done', updated_at = datetime('now', 'localtime') WHERE id = ? AND bot_id = ?"
  ).run(id, botId);
  return getTaskById(id);
}

export function deleteTask(id: number, botId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM tasks WHERE id = ? AND bot_id = ?").run(id, botId);
  return result.changes > 0;
}
