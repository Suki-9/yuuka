import { getDb } from "./database.js";

export interface MemoryRecord {
  id: number;
  bot_id: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/**
  * 新しい記憶（メモ）を追加する
  */
export function addMemory(botId: string, content: string): MemoryRecord {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bot_memories (bot_id, content, created_at, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
  `);
  const result = stmt.run(botId, content);
  const insertId = result.lastInsertRowid;
  return db.prepare("SELECT * FROM bot_memories WHERE id = ?").get(insertId) as MemoryRecord;
}

/**
  * 特定の記憶を取得する
  */
export function getMemory(botId: string, id: number): MemoryRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM bot_memories WHERE bot_id = ? AND id = ?").get(botId, id) as MemoryRecord | undefined;
}

/**
  * Botに紐づくすべての記憶を取得する（新しく追加された順）
  */
export function listMemories(botId: string): MemoryRecord[] {
  const db = getDb();
  return db.prepare("SELECT * FROM bot_memories WHERE bot_id = ? ORDER BY created_at DESC").all(botId) as MemoryRecord[];
}

/**
  * 記憶の内容を更新する
  */
export function updateMemory(botId: string, id: number, content: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE bot_memories
    SET content = ?, updated_at = datetime('now', 'localtime')
    WHERE bot_id = ? AND id = ?
  `).run(content, botId, id);
  return result.changes > 0;
}

/**
  * 記憶を削除する
  */
export function deleteMemory(botId: string, id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM bot_memories WHERE bot_id = ? AND id = ?").run(botId, id);
  return result.changes > 0;
}
