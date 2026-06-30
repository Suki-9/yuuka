import { getDb } from "./database.js";

// ─── ユーザー×Bot 有効モジュール上書き（function_modularization.md §4 改訂） ───
//
// 行が存在 = そのユーザーの上書き設定（有効モジュールIDのJSON配列。[] も有効な値）。
// 行が無い = Bot既定(bots.enabled_modules)へフォールバック。

/** ユーザーの上書きJSON文字列を取得（行が無ければ null = 未設定） */
export function getUserModulesJson(
	botId: string,
	userId: string,
): string | null {
	const row = getDb()
		.prepare(
			"SELECT enabled_modules FROM bot_user_modules WHERE bot_id = ? AND user_id = ?",
		)
		.get(botId, userId) as { enabled_modules: string } | undefined;
	return row ? row.enabled_modules : null;
}

/**
 * ユーザーの上書きを保存する。
 * enabledModules に配列を渡すと upsert、null を渡すと行を削除（Bot既定へフォールバック）。
 */
export function setUserModules(
	botId: string,
	userId: string,
	enabledModules: string[] | null,
): void {
	const db = getDb();
	if (enabledModules == null) {
		db.prepare(
			"DELETE FROM bot_user_modules WHERE bot_id = ? AND user_id = ?",
		).run(botId, userId);
		return;
	}
	db.prepare(
		`INSERT INTO bot_user_modules (bot_id, user_id, enabled_modules)
     VALUES (?, ?, ?)
     ON CONFLICT(bot_id, user_id)
     DO UPDATE SET enabled_modules = excluded.enabled_modules,
                   updated_at = datetime('now', 'localtime')`,
	).run(botId, userId, JSON.stringify(enabledModules));
}
