import { getDb } from "./database.js";

// ─── リマインド リポジトリ（§3.3） ──────────────────────────────────────────
//
// reminders テーブル（定義は migrations.ts）への永続化層。
// データ分離の原則: 全クエリは user_id (DiscordユーザーID) を WHERE 必須条件とする。
// 例外は cron 用の全件走査（listDuePending / markSent / rescheduleRepeat）のみ
// （リマインドエンジンが全ユーザー分を処理するため。各関数のコメント参照）。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export type ReminderTargetType = "dm" | "channel";
export type ReminderStatus = "pending" | "sent" | "cancelled";
export type ReminderSource =
	| "manual"
	| "todo"
	| "schedule"
	| "payment"
	| "birthday"
	| "webhook";

export interface ReminderRecord {
	id: number;
	user_id: string;
	bot_id: string;
	message: string;
	/** 送信予定日時 'YYYY-MM-DD HH:MM:SS'（ローカルタイム） */
	trigger_at: string;
	/** 繰り返しの場合の cron式（例: '0 9 * * 1' = 毎週月曜9時）。単発は NULL */
	repeat_rule: string | null;
	target_type: ReminderTargetType;
	target_id: string | null;
	status: ReminderStatus;
	source: ReminderSource;
	source_id: string | null;
	created_at: string;
}

export interface AddReminderInput {
	message: string;
	/** ISO 8601 / 'YYYY-MM-DD HH:MM:SS' / Date のいずれか（内部でDB形式へ正規化） */
	triggerAt: string | Date;
	repeatRule?: string;
	targetType?: ReminderTargetType;
	targetId?: string;
	source?: ReminderSource;
	sourceId?: string;
}

// ─── 日時フォーマットヘルパー ────────────────────────────────────────────────

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * 日時を DB 既存形式 'YYYY-MM-DD HH:MM:SS'（ローカルタイム）へ正規化する。
 * - Date オブジェクト: そのままローカルタイムで整形
 * - 'YYYY-MM-DD': その日のローカル 00:00:00 として解釈（UTC解釈を防ぐため T00:00:00 を補完）
 * - 'YYYY-MM-DD HH:MM[:SS]' / ISO 8601（オフセット付き含む）: ローカルタイムへ変換して整形
 * @throws 日時として解釈できない場合
 */
// 日時変換は utils/datetime.ts を正とし、後方互換のため再エクスポートする
export { toDbDateTime, parseDbDateTime } from "../utils/datetime.js";
import { toDbDateTime, parseDbDateTime } from "../utils/datetime.js";

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * リマインドを登録する（§3.3.1: 時刻指定 / 繰り返し / 各機能からの自動生成）。
 * triggerAt は DB 形式へ正規化して保存する。
 */
export function addReminder(
	userId: string,
	botId: string,
	input: AddReminderInput,
): ReminderRecord {
	const db = getDb();
	const triggerAt = toDbDateTime(input.triggerAt);
	const result = db
		.prepare(
			`INSERT INTO reminders (user_id, bot_id, message, trigger_at, repeat_rule, target_type, target_id, source, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			userId,
			botId,
			input.message,
			triggerAt,
			input.repeatRule ?? null,
			input.targetType ?? "dm",
			input.targetId ?? null,
			input.source ?? "manual",
			input.sourceId ?? null,
		);
	return getReminderById(userId, botId, result.lastInsertRowid as number)!;
}

/** リマインドを1件取得する（本人スコープ） */
export function getReminderById(
	userId: string,
	botId: string,
	id: number,
): ReminderRecord | undefined {
	const db = getDb();
	return db
		.prepare(
			"SELECT * FROM reminders WHERE id = ? AND user_id = ? AND bot_id = ?",
		)
		.get(id, userId, botId) as ReminderRecord | undefined;
}

/**
 * リマインド一覧を取得する（本人スコープ）。
 * @param includeAll true の場合は送信済み・キャンセル済みも含める（既定は pending のみ）
 */
export function listReminders(
	userId: string,
	botId: string,
	includeAll: boolean = false,
): ReminderRecord[] {
	const db = getDb();
	if (includeAll) {
		return db
			.prepare(
				`SELECT * FROM reminders WHERE user_id = ? AND bot_id = ?
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, trigger_at ASC`,
			)
			.all(userId, botId) as ReminderRecord[];
	}
	return db
		.prepare(
			"SELECT * FROM reminders WHERE user_id = ? AND bot_id = ? AND status = 'pending' ORDER BY trigger_at ASC",
		)
		.all(userId, botId) as ReminderRecord[];
}

/**
 * リマインドをキャンセルする（本人スコープ、pending のみ対象）。
 * @returns キャンセル後のレコード。対象が存在しない（または pending でない）場合は undefined
 */
export function cancelReminder(
	userId: string,
	botId: string,
	id: number,
): ReminderRecord | undefined {
	const db = getDb();
	const result = db
		.prepare(
			"UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND bot_id = ? AND status = 'pending'",
		)
		.run(id, userId, botId);
	if (result.changes === 0) return undefined;
	return getReminderById(userId, botId, id);
}

/**
 * リマインドを送信済みにする。
 * 注意: cron（リマインドエンジン）が listDuePending の結果に対して呼ぶ専用関数のため、
 * 例外的に user_id スコープなし（id は listDuePending で全ユーザー走査済み）。
 */
export function markSent(id: number): void {
	const db = getDb();
	db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(id);
}

/**
 * 繰り返しリマインドの次回送信時刻を設定し、status を pending に戻す（§3.3.2）。
 * 注意: cron（リマインドエンジン）専用のため、例外的に user_id スコープなし。
 */
export function rescheduleRepeat(
	id: number,
	nextTriggerAt: string | Date,
): void {
	const db = getDb();
	db.prepare(
		"UPDATE reminders SET trigger_at = ?, status = 'pending' WHERE id = ?",
	).run(toDbDateTime(nextTriggerAt), id);
}

/**
 * 送信時刻を迎えた pending リマインドを全ユーザー分取得する（§3.3.2）。
 * 注意: cron（リマインドエンジン）用の全件走査のため、例外的に user_id スコープなし。
 * 計画外停止からの復帰（§10）も兼ねる: 過去分も trigger_at <= now で全て拾われる。
 */
export function listDuePending(): ReminderRecord[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM reminders
       WHERE status = 'pending' AND trigger_at <= datetime('now', 'localtime')
       ORDER BY trigger_at ASC`,
		)
		.all() as ReminderRecord[];
}
