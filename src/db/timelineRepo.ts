import fs from "node:fs";
import path from "node:path";
import { getDb } from "./database.js";
import { addExpense } from "./expenseRepo.js";

// ─── デイリータイムライン リポジトリ（§3.X: 計画ブロック + 汎用記録層） ──────

export type PlanBlockType = "task" | "transit" | "event" | "free";
export type RecordType = "memo" | "expense" | "task_done" | "media" | "location";

export interface DayPlanBlock {
	id: number;
	user_id: string;
	bot_id: string;
	/** 'YYYY-MM-DD' */
	date: string;
	/** 'HH:MM' */
	start_time: string | null;
	/** 'HH:MM' */
	end_time: string | null;
	type: PlanBlockType;
	title: string;
	description: string | null;
	todo_id: number | null;
	transit_from: string | null;
	transit_to: string | null;
	transit_line: string | null;
	position: number;
	created_at: string;
	updated_at: string;
}

export interface TimelineRecord {
	id: number;
	user_id: string;
	bot_id: string;
	/** 'YYYY-MM-DD' */
	date: string;
	/** datetime */
	recorded_at: string;
	type: RecordType;
	title: string | null;
	content: string | null;
	todo_id: number | null;
	expense_id: number | null;
	amount: number | null;
	expense_category: string | null;
	/** 相対パス: 'YYYYMM-timestamp-hash.ext' */
	media_path: string | null;
	/** 'photo' | 'video' */
	media_type: string | null;
	location: string | null;
	created_at: string;
}

// ─── メディアストレージ ────────────────────────────────────────────────────────

const MEDIA_DIR = path.resolve(process.cwd(), "data", "media");
const ALLOWED_MEDIA_EXTS = new Set([
	".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif",
	".mp4", ".mov", ".webm", ".m4v",
]);

/** base64 または Discord CDN URL からメディアをローカル保存し、相対パスを返す */
export async function saveMediaFile(opts: {
	base64?: string;
	url?: string;
	mimeType: string;
	date: string;
}): Promise<string> {
	fs.mkdirSync(MEDIA_DIR, { recursive: true });

	const ext = mimeTypeToExt(opts.mimeType);
	if (!ALLOWED_MEDIA_EXTS.has(ext)) throw new Error(`不正なメディア形式: ${opts.mimeType}`);

	const yyyymm = opts.date.slice(0, 7).replace("-", "");
	const filename = `${yyyymm}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
	const fullPath = path.join(MEDIA_DIR, filename);

	if (opts.base64) {
		fs.writeFileSync(fullPath, Buffer.from(opts.base64, "base64"));
	} else if (opts.url) {
		const res = await fetch(opts.url);
		if (!res.ok) throw new Error(`メディアのダウンロードに失敗しました: ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		fs.writeFileSync(fullPath, buf);
	} else {
		throw new Error("base64 または url が必要です");
	}

	return filename;
}

/** メディアファイルのフルパスを返す（path traversal 対策済み） */
export function resolveMediaPath(filename: string): string | null {
	if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) return null;
	const fullPath = path.join(MEDIA_DIR, filename);
	if (!fullPath.startsWith(MEDIA_DIR + path.sep)) return null;
	return fullPath;
}

function mimeTypeToExt(mime: string): string {
	const map: Record<string, string> = {
		"image/jpeg": ".jpg",
		"image/jpg": ".jpg",
		"image/png": ".png",
		"image/webp": ".webp",
		"image/gif": ".gif",
		"image/heic": ".heic",
		"image/heif": ".heif",
		"video/mp4": ".mp4",
		"video/quicktime": ".mov",
		"video/webm": ".webm",
		"video/x-m4v": ".m4v",
	};
	return map[mime.toLowerCase()] ?? ".bin";
}

// ─── day_plan_blocks ──────────────────────────────────────────────────────────

export interface DayPlanBlockInput {
	date: string;
	type: PlanBlockType;
	title: string;
	description?: string;
	startTime?: string;
	endTime?: string;
	todoId?: number;
	transitFrom?: string;
	transitTo?: string;
	transitLine?: string;
	position?: number;
}

export function addDayPlanBlock(
	userId: string,
	botId: string,
	input: DayPlanBlockInput,
): DayPlanBlock {
	const db = getDb();
	const result = db.prepare(`
		INSERT INTO day_plan_blocks
			(user_id, bot_id, date, start_time, end_time, type, title, description,
			 todo_id, transit_from, transit_to, transit_line, position)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		userId, botId,
		input.date,
		input.startTime ?? null,
		input.endTime ?? null,
		input.type,
		input.title,
		input.description ?? null,
		input.todoId ?? null,
		input.transitFrom ?? null,
		input.transitTo ?? null,
		input.transitLine ?? null,
		input.position ?? 0,
	);
	return getDayPlanBlockById(result.lastInsertRowid as number)!;
}

export function getDayPlanBlockById(id: number): DayPlanBlock | undefined {
	return getDb().prepare(`SELECT * FROM day_plan_blocks WHERE id = ?`).get(id) as DayPlanBlock | undefined;
}

export function listDayPlanBlocks(userId: string, botId: string, date: string): DayPlanBlock[] {
	return getDb().prepare(`
		SELECT * FROM day_plan_blocks
		WHERE user_id = ? AND bot_id = ? AND date = ?
		ORDER BY
			CASE WHEN start_time IS NULL THEN 1 ELSE 0 END,
			start_time ASC,
			position ASC
	`).all(userId, botId, date) as DayPlanBlock[];
}

export function updateDayPlanBlock(
	userId: string,
	botId: string,
	id: number,
	input: Partial<Omit<DayPlanBlockInput, "date">>,
): DayPlanBlock | undefined {
	const db = getDb();
	const sets: string[] = ["updated_at = datetime('now','localtime')"];
	const params: unknown[] = [];
	if (input.title !== undefined) { sets.push("title = ?"); params.push(input.title); }
	if (input.description !== undefined) { sets.push("description = ?"); params.push(input.description || null); }
	if ("startTime" in input) { sets.push("start_time = ?"); params.push(input.startTime ?? null); }
	if ("endTime" in input) { sets.push("end_time = ?"); params.push(input.endTime ?? null); }
	if (input.type !== undefined) { sets.push("type = ?"); params.push(input.type); }
	if ("todoId" in input) { sets.push("todo_id = ?"); params.push(input.todoId ?? null); }
	if ("transitFrom" in input) { sets.push("transit_from = ?"); params.push(input.transitFrom ?? null); }
	if ("transitTo" in input) { sets.push("transit_to = ?"); params.push(input.transitTo ?? null); }
	if ("transitLine" in input) { sets.push("transit_line = ?"); params.push(input.transitLine ?? null); }
	if (input.position !== undefined) { sets.push("position = ?"); params.push(input.position); }
	const r = db.prepare(
		`UPDATE day_plan_blocks SET ${sets.join(", ")} WHERE user_id = ? AND bot_id = ? AND id = ?`
	).run(...params, userId, botId, id);
	return r.changes > 0 ? getDayPlanBlockById(id) : undefined;
}

export function deleteDayPlanBlock(userId: string, botId: string, id: number): boolean {
	return getDb().prepare(
		`DELETE FROM day_plan_blocks WHERE user_id = ? AND bot_id = ? AND id = ?`
	).run(userId, botId, id).changes > 0;
}

// ─── timeline_records ─────────────────────────────────────────────────────────

export interface TimelineRecordInput {
	date: string;
	recordedAt?: string;
	type: RecordType;
	title?: string;
	content?: string;
	todoId?: number;
	expenseId?: number;
	amount?: number;
	expenseCategory?: string;
	mediaPath?: string;
	mediaType?: string;
	location?: string;
}

export function addTimelineRecord(
	userId: string,
	botId: string,
	input: TimelineRecordInput,
): TimelineRecord {
	const db = getDb();
	const result = db.prepare(`
		INSERT INTO timeline_records
			(user_id, bot_id, date, recorded_at, type, title, content,
			 todo_id, expense_id, amount, expense_category, media_path, media_type, location)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		userId, botId,
		input.date,
		input.recordedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19),
		input.type,
		input.title ?? null,
		input.content ?? null,
		input.todoId ?? null,
		input.expenseId ?? null,
		input.amount ?? null,
		input.expenseCategory ?? null,
		input.mediaPath ?? null,
		input.mediaType ?? null,
		input.location ?? null,
	);
	return getTimelineRecordById(result.lastInsertRowid as number)!;
}

export function getTimelineRecordById(id: number): TimelineRecord | undefined {
	return getDb().prepare(`SELECT * FROM timeline_records WHERE id = ?`).get(id) as TimelineRecord | undefined;
}

export function listTimelineRecords(userId: string, botId: string, date: string): TimelineRecord[] {
	return getDb().prepare(`
		SELECT * FROM timeline_records
		WHERE user_id = ? AND bot_id = ? AND date = ?
		ORDER BY recorded_at ASC
	`).all(userId, botId, date) as TimelineRecord[];
}

export function deleteTimelineRecord(userId: string, botId: string, id: number): boolean {
	return getDb().prepare(
		`DELETE FROM timeline_records WHERE user_id = ? AND bot_id = ? AND id = ?`
	).run(userId, botId, id).changes > 0;
}

/** type=expense の記録を追加し、既存expenses テーブルにも登録する */
export async function addExpenseRecord(
	userId: string,
	botId: string,
	input: {
		date: string;
		recordedAt?: string;
		amount: number;
		category: string;
		title?: string;
		location?: string;
	},
): Promise<TimelineRecord> {
	const expTime = input.recordedAt ? input.recordedAt.slice(11, 19) : undefined;
	const expense = addExpense(userId, botId, input.amount, input.category, input.title, input.date, expTime, "timeline");
	return addTimelineRecord(userId, botId, {
		date: input.date,
		recordedAt: input.recordedAt,
		type: "expense",
		title: input.title,
		amount: input.amount,
		expenseCategory: input.category,
		expenseId: expense.id,
		location: input.location,
	});
}
