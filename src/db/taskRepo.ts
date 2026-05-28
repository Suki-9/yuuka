import { getDb } from "./database.js";

export interface Task {
  id: number;
  user_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export function addTask(
  userId: string,
  title: string,
  description?: string,
  dueDate?: string,
  priority?: number
): Task {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tasks (user_id, title, description, due_date, priority)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(userId, title, description ?? null, dueDate ?? null, priority ?? 0);
  return getTaskById(result.lastInsertRowid as number)!;
}

export function listTasks(userId: string, status?: string): Task[] {
  const db = getDb();
  if (status && status !== "all") {
    return db
      .prepare("SELECT * FROM tasks WHERE user_id = ? AND status = ? ORDER BY priority DESC, created_at DESC")
      .all(userId, status) as Task[];
  }
  return db
    .prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY status ASC, priority DESC, created_at DESC")
    .all(userId) as Task[];
}

export function getTaskById(id: number): Task | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
}

export function completeTask(id: number, userId: string): Task | undefined {
  const db = getDb();
  db.prepare(
    "UPDATE tasks SET status = 'done', updated_at = datetime('now', 'localtime') WHERE id = ? AND user_id = ?"
  ).run(id, userId);
  return getTaskById(id);
}

export function deleteTask(id: number, userId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}
