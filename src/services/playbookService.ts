import { getDb } from "../db/database.js";

// ─── マクロ（Playbook）管理（§3.6） ──────────────────────────────────────────
// 仕様§3.6の「マクロ」は本Playbook機構で実現する。
// steps はMarkdown手順（またはFunction Call列の記述）として保存し、
// 呼び出し時はLLMがその手順に従って各ツールを実行する。

export interface Playbook {
	name: string;
	title: string;
	keywords: string[];
	description: string;
	steps: string;
}

/**
 * マクロ（Playbook）をデータベースに保存する（INSERT または UPDATE）
 */
export function savePlaybook(
	userId: string,
	botId: string,
	name: string,
	title: string,
	keywords: string[],
	description: string,
	steps: string,
): { success: boolean; message: string } {
	const db = getDb();
	const safeName = name.replace(/[^a-zA-Z0-9\-_]/g, "_").toLowerCase();
	if (!safeName) {
		return { success: false, message: "マクロ名（英数字）が不正です。" };
	}
	const keywordsJson = JSON.stringify(keywords);

	const stmt = db.prepare(`
    INSERT INTO playbooks (user_id, bot_id, name, title, keywords, description, steps)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, bot_id, name) DO UPDATE SET
      title = excluded.title,
      keywords = excluded.keywords,
      description = excluded.description,
      steps = excluded.steps,
      updated_at = datetime('now', 'localtime')
  `);
	stmt.run(userId, botId, safeName, title, keywordsJson, description, steps);

	return {
		success: true,
		message: `マクロ「${title}」を ${safeName} として正常に保存しました。`,
	};
}

/**
 * キーワードや部分一致でマクロ（Playbook）を検索し、その中身を返す
 */
export function findPlaybooks(
	userId: string,
	botId: string,
	query?: string,
): Playbook[] {
	const db = getDb();

	let rows: any[];
	if (query) {
		const likePattern = `%${query}%`;
		rows = db
			.prepare(`
      SELECT name, title, keywords, description, steps
      FROM playbooks
      WHERE user_id = ? AND bot_id = ? AND (
        name LIKE ? OR title LIKE ? OR description LIKE ? OR steps LIKE ? OR keywords LIKE ?
      )
      ORDER BY updated_at DESC
    `)
			.all(
				userId,
				botId,
				likePattern,
				likePattern,
				likePattern,
				likePattern,
				likePattern,
			);
	} else {
		rows = db
			.prepare(`
      SELECT name, title, keywords, description, steps
      FROM playbooks
      WHERE user_id = ? AND bot_id = ?
      ORDER BY updated_at DESC
    `)
			.all(userId, botId);
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
 * マクロ（Playbook）を名前で1件取得する
 */
export function getPlaybookByName(
	userId: string,
	botId: string,
	name: string,
): Playbook | null {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT name, title, keywords, description, steps FROM playbooks WHERE user_id = ? AND bot_id = ? AND name = ?`,
		)
		.get(userId, botId, name) as any;
	if (!row) return null;
	let keywords: string[] = [];
	try {
		keywords = JSON.parse(row.keywords || "[]");
	} catch {}
	return {
		name: row.name,
		title: row.title,
		keywords,
		description: row.description || "",
		steps: row.steps || "",
	};
}

/**
 * マクロ（Playbook）を削除する
 */
export function deletePlaybook(
	userId: string,
	botId: string,
	name: string,
): boolean {
	const db = getDb();
	const stmt = db.prepare(
		"DELETE FROM playbooks WHERE user_id = ? AND bot_id = ? AND name = ?",
	);
	const result = stmt.run(userId, botId, name);
	return result.changes > 0;
}
