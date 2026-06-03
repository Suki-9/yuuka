import { getDb } from "../db/database.js";

export interface Playbook {
  name: string;
  title: string;
  keywords: string[];
  description: string;
  steps: string;
}

/**
 * 手順書（Playbook）をデータベースに保存する（INSERT または REPLACE）
 */
export function savePlaybook(
  botId: string,
  name: string,
  title: string,
  keywords: string[],
  description: string,
  steps: string
): { success: boolean; message: string } {
  const db = getDb();
  const safeName = name.replace(/[^a-zA-Z0-9\-_]/g, "_").toLowerCase();
  const keywordsJson = JSON.stringify(keywords);

  const stmt = db.prepare(`
    INSERT INTO playbooks (bot_id, name, title, keywords, description, steps)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, name) DO UPDATE SET
      title = excluded.title,
      keywords = excluded.keywords,
      description = excluded.description,
      steps = excluded.steps,
      updated_at = datetime('now', 'localtime')
  `);
  stmt.run(botId, safeName, title, keywordsJson, description, steps);

  return {
    success: true,
    message: `手順書「${title}」を ${safeName} として正常に保存しました。`,
  };
}

/**
 * キーワードや部分一致で手順書（Playbook）を検索し、その中身を返す
 */
export function findPlaybooks(botId: string, query?: string): Playbook[] {
  const db = getDb();

  let rows: any[];
  if (query) {
    const likePattern = `%${query}%`;
    rows = db.prepare(`
      SELECT name, title, keywords, description, steps
      FROM playbooks
      WHERE bot_id = ? AND (
        title LIKE ? OR description LIKE ? OR steps LIKE ? OR keywords LIKE ?
      )
      ORDER BY updated_at DESC
    `).all(botId, likePattern, likePattern, likePattern, likePattern);
  } else {
    rows = db.prepare(`
      SELECT name, title, keywords, description, steps
      FROM playbooks
      WHERE bot_id = ?
      ORDER BY updated_at DESC
    `).all(botId);
  }

  return rows.map((row: any) => {
    let keywords: string[] = [];
    try {
      keywords = JSON.parse(row.keywords || "[]");
    } catch {
      keywords = [];
    }
    return {
      name: row.name,
      title: row.title,
      keywords,
      description: row.description || "",
      steps: row.steps || "",
    };
  });
}

/**
 * 手順書（Playbook）を削除する
 */
export function deletePlaybook(botId: string, name: string): boolean {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM playbooks WHERE bot_id = ? AND name = ?");
  const result = stmt.run(botId, name);
  return result.changes > 0;
}

