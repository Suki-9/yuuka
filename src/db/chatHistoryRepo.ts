import { getDb } from "./database.js";

export interface ChatHistoryEntry {
  role: "user" | "model";
  text: string;
}

/**
 * チャット履歴に新しいメッセージを追加する
 */
export function addChatMessage(userId: string, role: "user" | "model", text: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO chat_history (user_id, role, text)
    VALUES (?, ?, ?)
  `);
  stmt.run(userId, role, text);
}

/**
 * 直近のチャット履歴を取得する（古い順）
 */
export function getRecentChatHistory(userId: string, limit: number = 20): ChatHistoryEntry[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT role, text FROM (
      SELECT role, text, id FROM chat_history
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    )
    ORDER BY id ASC
  `);
  
  const rows = stmt.all(userId, limit) as { role: string; text: string }[];
  return rows.map((row) => ({
    role: row.role as "user" | "model",
    text: row.text,
  }));
}

/**
 * 特定のユーザーのチャット履歴をクリアする
 */
export function clearChatHistory(userId: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM chat_history WHERE user_id = ?
  `);
  stmt.run(userId);
}
