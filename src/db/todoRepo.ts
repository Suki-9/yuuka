import { getDb } from "./database.js";

// ─── ToDo リポジトリ（§3.2） ─────────────────────────────────────────────────
//
// todos テーブル（スキーマ定義は db/migrations.ts が唯一の定義元）のリポジトリ。
// データ分離の原則: 全クエリは user_id (DiscordユーザーID) を WHERE 必須条件とする。
// 例外は cron 用の全ユーザー走査（listOpenTodosDueWithinAcrossUsers / markDueReminded）のみ。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

/** ToDo の優先度（§3.2.3: LLM提案 → ユーザー承認後に確定） */
export type TodoPriority = "high" | "medium" | "low";

/** todos テーブルの1レコード（tags は JSON string[] の生文字列） */
export interface TodoRecord {
	id: number;
	user_id: string;
	bot_id: string;
	title: string;
	description: string | null;
	due_date: string | null;
	/** v12: ガントのバー始端（ISO 8601。任意） */
	start_date: string | null;
	priority: TodoPriority | null;
	tags: string;
	status: "open" | "done";
	/** v12: 手動進捗 0-100（葉タスク用。子を持つ親は completeEffectiveProgress で算出する） */
	progress: number;
	/** v12: 自己参照。NULL=親タスク / 値=サブタスクの親ID（1階層のみ） */
	parent_id: number | null;
	linked_payment_id: number | null;
	due_reminded: number;
	/** v16: ルーチンの周期（cron式）。NULL=単発タスク */
	repeat_rule: string | null;
	/** v16: 繰り返し終了日 'YYYY-MM-DD'。NULL=無期限 */
	repeat_until: string | null;
	/** v16: 残り繰り返し回数（現在分を含む）。NULL=無制限 */
	repeat_count: number | null;
	created_at: string;
	updated_at: string;
}

/** 親タスク＋サブタスク＋算出進捗を束ねた読み取り専用ビュー（一覧・ガント用） */
export interface TodoWithSubtasks extends TodoRecord {
	subtasks: TodoRecord[];
	/** 算出進捗 0-100（子があれば「完了子数/全体」、無ければ葉の progress または done→100） */
	effective_progress: number;
}

/** task_progress_logs の1レコード（進捗報告の時系列ログ） */
export interface TaskProgressLogRecord {
	id: number;
	user_id: string;
	bot_id: string;
	todo_id: number;
	progress: number;
	note: string | null;
	created_at: string;
}

/** addTodo の入力 */
export interface TodoInput {
	title: string;
	description?: string;
	dueDate?: string;
	/** v12: 開始日（ISO 8601。任意） */
	startDate?: string;
	priority?: TodoPriority;
	tags?: string[];
	/** v12: サブタスクにする場合の親ToDoのID（1階層のみ。2階層目以降は親へ平坦化される） */
	parentId?: number;
	/** v16: ルーチンの周期（cron式）。指定するとルーチンタスクになる */
	repeatRule?: string;
	/** v16: 繰り返し終了日 'YYYY-MM-DD'（任意） */
	repeatUntil?: string;
	/** v16: 繰り返し回数（現在分を含む。任意） */
	repeatCount?: number;
}

/** updateTodo の入力（指定されたフィールドのみ更新） */
export interface TodoUpdateInput {
	title?: string;
	description?: string;
	dueDate?: string;
	/** v12: 開始日（空文字でクリア） */
	startDate?: string;
	priority?: TodoPriority;
	status?: "open" | "done";
}

/** listTodos のフィルタ条件 */
export interface TodoListFilter {
	/** ステータス絞り込み（デフォルト 'open'） */
	status?: "open" | "done" | "all";
	/** 指定タグを持つToDoのみ（§3.2.4: グループ別表示） */
	tag?: string;
	/**
	 * v12: 親子の絞り込み。
	 * - null  → 親タスクのみ（parent_id IS NULL）
	 * - number → 指定IDのサブタスクのみ
	 * - undefined → 親子を区別せず全件（後方互換）
	 */
	parentId?: number | null;
}

/** タグ集計結果（§3.2.4: タグ一覧・グループ表示用） */
export interface TagCount {
	tag: string;
	count: number;
}

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** TodoRecord.tags（JSON文字列）を string[] に安全にパースする */
export function parseTodoTags(todo: Pick<TodoRecord, "tags">): string[] {
	try {
		const parsed = JSON.parse(todo.tags);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t): t is string => typeof t === "string");
	} catch {
		return [];
	}
}

/** 一覧の共通並び順: 優先度（high→medium→low→未設定）→ 期限近い順（期限なしは後ろ）→ 新しい順 */
const ORDER_CLAUSE = `
  ORDER BY
    CASE status WHEN 'open' THEN 0 ELSE 1 END,
    CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
    CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
    datetime(due_date) ASC,
    created_at DESC
`;

// ─── 追加・取得 ──────────────────────────────────────────────────────────────

/**
 * サブタスクの親IDを1階層に正規化する。
 * - 親が存在しない／本人のものでない → null（トップレベル化）
 * - 親自身がサブタスク（parent_id あり）→ その親（祖父）に付け替え、常に深さ1を保証する
 */
function normalizeParentId(
	userId: string,
	botId: string,
	parentId: number | null | undefined,
): number | null {
	if (parentId == null) return null;
	const parent = getTodoById(userId, botId, parentId);
	if (!parent) return null;
	return parent.parent_id != null ? parent.parent_id : parent.id;
}

/** ToDo を追加する（タグは省略時は空配列。LLMによる自動付与は autoTagService が後追いで行う） */
export function addTodo(
	userId: string,
	botId: string,
	input: TodoInput,
): TodoRecord {
	const db = getDb();
	const parentId = normalizeParentId(userId, botId, input.parentId);
	const result = db
		.prepare(
			`INSERT INTO todos (user_id, bot_id, title, description, due_date, start_date, priority, tags, parent_id, repeat_rule, repeat_until, repeat_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			userId,
			botId,
			input.title,
			input.description ?? null,
			input.dueDate ?? null,
			input.startDate ?? null,
			input.priority ?? null,
			JSON.stringify(input.tags ?? []),
			parentId,
			// サブタスク（parentId あり）はルーチンにしない（親のみ繰り返し対象とする）
			parentId == null ? (input.repeatRule ?? null) : null,
			parentId == null ? (input.repeatUntil ?? null) : null,
			parentId == null ? (input.repeatCount ?? null) : null,
		);
	return getTodoById(userId, botId, result.lastInsertRowid as number)!;
}

/** ID指定で1件取得する（本人のToDoのみ） */
export function getTodoById(
	userId: string,
	botId: string,
	id: number,
): TodoRecord | undefined {
	const db = getDb();
	return db
		.prepare("SELECT * FROM todos WHERE user_id = ? AND bot_id = ? AND id = ?")
		.get(userId, botId, id) as TodoRecord | undefined;
}

/** スコープ更新の共通後処理: 変更が無ければ undefined、あれば更新後の最新レコードを返す */
function reloadIfChanged(
	changes: number,
	userId: string,
	botId: string,
	id: number,
): TodoRecord | undefined {
	return changes === 0 ? undefined : getTodoById(userId, botId, id);
}

/**
 * ToDo 一覧を取得する（§3.2.1: 未完了・完了済み・タグ別表示）。
 * tag 指定時は tags JSON 配列に該当タグを含むもののみ返す（json_each で展開して照合）。
 */
export function listTodos(
	userId: string,
	botId: string,
	filter: TodoListFilter = {},
): TodoRecord[] {
	const db = getDb();
	const status = filter.status ?? "open";

	const conditions: string[] = ["user_id = ?", "bot_id = ?"];
	const params: unknown[] = [userId, botId];

	if (status !== "all") {
		conditions.push("status = ?");
		params.push(status);
	}
	if (filter.tag) {
		conditions.push(
			"EXISTS (SELECT 1 FROM json_each(todos.tags) WHERE json_each.value = ?)",
		);
		params.push(filter.tag);
	}
	// v12: 親子の絞り込み（null=親のみ / number=指定親のサブタスク / undefined=全件）
	if (filter.parentId === null) {
		conditions.push("parent_id IS NULL");
	} else if (typeof filter.parentId === "number") {
		conditions.push("parent_id = ?");
		params.push(filter.parentId);
	}

	return db
		.prepare(
			`SELECT * FROM todos WHERE ${conditions.join(" AND ")} ${ORDER_CLAUSE}`,
		)
		.all(...params) as TodoRecord[];
}

// ─── 更新 ────────────────────────────────────────────────────────────────────

/**
 * ToDo を部分更新する（指定フィールドのみ）。
 * 期限（due_date）を変更した場合は due_reminded をリセットし、新しい期限で再度リマインドされるようにする。
 */
export function updateTodo(
	userId: string,
	botId: string,
	id: number,
	input: TodoUpdateInput,
): TodoRecord | undefined {
	const db = getDb();
	const sets: string[] = [];
	const params: unknown[] = [];

	if (input.title !== undefined) {
		sets.push("title = ?");
		params.push(input.title);
	}
	if (input.description !== undefined) {
		sets.push("description = ?");
		params.push(input.description);
	}
	if (input.dueDate !== undefined) {
		// 空文字は期限クリア（NULL）として扱う
		sets.push("due_date = ?", "due_reminded = 0");
		params.push(input.dueDate === "" ? null : input.dueDate);
	}
	if (input.startDate !== undefined) {
		// v12: 空文字は開始日クリア（NULL）
		sets.push("start_date = ?");
		params.push(input.startDate === "" ? null : input.startDate);
	}
	if (input.priority !== undefined) {
		sets.push("priority = ?");
		params.push(input.priority);
	}
	if (input.status !== undefined) {
		sets.push("status = ?");
		params.push(input.status);
	}
	if (sets.length === 0) {
		return getTodoById(userId, botId, id);
	}

	sets.push("updated_at = datetime('now', 'localtime')");
	const result = db
		.prepare(
			`UPDATE todos SET ${sets.join(", ")} WHERE user_id = ? AND bot_id = ? AND id = ?`,
		)
		.run(...params, userId, botId, id);
	return reloadIfChanged(result.changes, userId, botId, id);
}

/** タグを上書き保存する（§3.2.4: LLM自動付与の保存先。autoTagService から呼ばれる） */
export function updateTodoTags(
	userId: string,
	botId: string,
	id: number,
	tags: string[],
): boolean {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE todos SET tags = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ?`,
		)
		.run(JSON.stringify(tags), userId, botId, id);
	return result.changes > 0;
}

/**
 * 優先度の一括更新（§3.2.3: ユーザー承認後の確定処理）。
 * トランザクションで全件を原子的に更新し、実際に更新された件数を返す。
 */
export function updateTodoPriorities(
	userId: string,
	botId: string,
	items: { id: number; priority: TodoPriority }[],
): number {
	const db = getDb();
	const stmt = db.prepare(
		`UPDATE todos SET priority = ?, updated_at = datetime('now', 'localtime')
     WHERE user_id = ? AND bot_id = ? AND id = ? AND status = 'open'`,
	);
	const applyAll = db.transaction(
		(rows: { id: number; priority: TodoPriority }[]) => {
			let updated = 0;
			for (const row of rows) {
				updated += stmt.run(row.priority, userId, botId, row.id).changes;
			}
			return updated;
		},
	);
	return applyAll(items);
}

/** ToDo を完了にする */
export function completeTodo(
	userId: string,
	botId: string,
	id: number,
): TodoRecord | undefined {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE todos SET status = 'done', updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ?`,
		)
		.run(userId, botId, id);
	return reloadIfChanged(result.changes, userId, botId, id);
}

/**
 * ToDo を削除する。親を削除した場合はサブタスクも一緒に削除する。
 * ※ 既存DBは parent_id を ALTER ADD COLUMN で後付けするため FK ON DELETE CASCADE が効かない。
 *    新規DB・既存DBの双方で確実に連鎖削除するため、ここで明示的に子も削除する（深さ1前提）。
 *    進捗ログ(task_progress_logs)は常に FK 付きで新規作成されるため、各行削除でカスケード除去される。
 */
export function deleteTodo(userId: string, botId: string, id: number): boolean {
	const db = getDb();
	const result = db
		.prepare(
			"DELETE FROM todos WHERE user_id = ? AND bot_id = ? AND (id = ? OR parent_id = ?)",
		)
		.run(userId, botId, id, id);
	return result.changes > 0;
}

// ─── 進捗・サブタスク・ガント（§3.2 v12） ────────────────────────────────────

/** サブタスク一覧（指定親の子を全件。ステータス問わず） */
export function listSubtasks(
	userId: string,
	botId: string,
	parentId: number,
): TodoRecord[] {
	return listTodos(userId, botId, { status: "all", parentId });
}

/**
 * 算出進捗（0-100）を求める。
 * - サブタスクあり: 完了サブタスク数 / 全サブタスク数 ×100（ユーザー選択の算出方式）
 * - サブタスクなし: status=done なら100、それ以外は手動 progress
 */
export function computeEffectiveProgress(
	todo: TodoRecord,
	subtasks: TodoRecord[],
): number {
	if (subtasks.length > 0) {
		const done = subtasks.filter((s) => s.status === "done").length;
		return Math.round((done / subtasks.length) * 100);
	}
	return todo.status === "done" ? 100 : (todo.progress ?? 0);
}

/** 子レコードを親IDでグルーピングする（深さ1前提） */
function groupChildren(rows: TodoRecord[]): Map<number, TodoRecord[]> {
	const map = new Map<number, TodoRecord[]>();
	for (const r of rows) {
		if (r.parent_id == null) continue;
		const arr = map.get(r.parent_id);
		if (arr) arr.push(r);
		else map.set(r.parent_id, [r]);
	}
	return map;
}

/** 親ToDoの配列へサブタスクと算出進捗を束ねる（子は1クエリでまとめて取得） */
function attachSubtasks(
	userId: string,
	botId: string,
	parents: TodoRecord[],
): TodoWithSubtasks[] {
	if (parents.length === 0) return [];
	const db = getDb();
	const ids = parents.map((p) => p.id);
	const placeholders = ids.map(() => "?").join(", ");
	const children = db
		.prepare(
			`SELECT * FROM todos
       WHERE user_id = ? AND bot_id = ? AND parent_id IN (${placeholders})
       ${ORDER_CLAUSE}`,
		)
		.all(userId, botId, ...ids) as TodoRecord[];
	const byParent = groupChildren(children);
	return parents.map((p) => {
		const subtasks = byParent.get(p.id) ?? [];
		return {
			...p,
			subtasks,
			effective_progress: computeEffectiveProgress(p, subtasks),
		};
	});
}

/**
 * 親タスク一覧（サブタスク・算出進捗付き）を返す。一覧UI／LLMの構造化表示用。
 * filter.status/tag は親に適用し、サブタスクは状態に関わらず全件同梱する（進捗算出のため）。
 */
export function listTodoTree(
	userId: string,
	botId: string,
	filter: TodoListFilter = {},
): TodoWithSubtasks[] {
	const parents = listTodos(userId, botId, { ...filter, parentId: null });
	return attachSubtasks(userId, botId, parents);
}

/**
 * ガント表示対象（開始日 or 期限のどちらかを持つ親タスク）をサブタスク付きで返す。
 * 両方未設定のタスクは listSomedayTasks（いつかやる）へ回す仕様のため除外する。
 */
export function listGanttTasks(
	userId: string,
	botId: string,
): TodoWithSubtasks[] {
	const db = getDb();
	const parents = db
		.prepare(
			`SELECT * FROM todos
       WHERE user_id = ? AND bot_id = ? AND parent_id IS NULL
         AND (start_date IS NOT NULL OR due_date IS NOT NULL)
       ORDER BY
         CASE WHEN COALESCE(start_date, due_date) IS NULL THEN 1 ELSE 0 END,
         datetime(COALESCE(start_date, due_date)) ASC,
         datetime(COALESCE(due_date, start_date)) ASC,
         created_at DESC`,
		)
		.all(userId, botId) as TodoRecord[];
	return attachSubtasks(userId, botId, parents);
}

/**
 * 「いつかやる」（開始日・期限とも未設定の親タスク）をサブタスク付きで返す。
 * ガントには載せられないタスクの受け皿。
 */
export function listSomedayTasks(
	userId: string,
	botId: string,
): TodoWithSubtasks[] {
	const db = getDb();
	const parents = db
		.prepare(
			`SELECT * FROM todos
       WHERE user_id = ? AND bot_id = ? AND parent_id IS NULL
         AND start_date IS NULL AND due_date IS NULL
       ${ORDER_CLAUSE}`,
		)
		.all(userId, botId) as TodoRecord[];
	return attachSubtasks(userId, botId, parents);
}

/**
 * 進捗を更新し、進捗ログ（task_progress_logs）へ1件追記する（トランザクション）。
 * progress は 0-100 にクランプ。100 で status=done、100未満で status=open へ同期する。
 * 子を持つ親タスクは進捗が子から算出されるため、ここでは呼ばないこと（呼び出し側で弾く）。
 * 戻り値は更新後の TodoRecord（対象が無ければ undefined）。
 */
export function updateProgress(
	userId: string,
	botId: string,
	id: number,
	progress: number,
	note?: string,
): TodoRecord | undefined {
	const db = getDb();
	const clamped = Math.max(0, Math.min(100, Math.round(progress)));
	const tx = db.transaction((): boolean => {
		const upd = db
			.prepare(
				`UPDATE todos
         SET progress = ?,
             status = CASE WHEN ? >= 100 THEN 'done' ELSE 'open' END,
             updated_at = datetime('now', 'localtime')
         WHERE user_id = ? AND bot_id = ? AND id = ?`,
			)
			.run(clamped, clamped, userId, botId, id);
		if (upd.changes === 0) return false;
		db.prepare(
			`INSERT INTO task_progress_logs (user_id, bot_id, todo_id, progress, note)
       VALUES (?, ?, ?, ?, ?)`,
		).run(userId, botId, id, clamped, note ?? null);
		return true;
	});
	if (!tx()) return undefined;
	return getTodoById(userId, botId, id);
}

/** 進捗ログを新しい順で取得する */
export function listProgressLogs(
	userId: string,
	botId: string,
	todoId: number,
): TaskProgressLogRecord[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM task_progress_logs
       WHERE user_id = ? AND bot_id = ? AND todo_id = ?
       ORDER BY datetime(created_at) DESC, id DESC`,
		)
		.all(userId, botId, todoId) as TaskProgressLogRecord[];
}

// ─── タグ集計（§3.2.4） ──────────────────────────────────────────────────────

/**
 * 未完了ToDoのタグを集計して使用回数順に返す（§3.2.4: タグ一覧・グループ表示・既存語彙の学習）。
 * タグを持つ未完了タスクが0件になったタグは自動的に結果から消える（明示削除は行わない仕様）。
 */
export function listAllTags(userId: string, botId: string): TagCount[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT json_each.value AS tag, COUNT(*) AS count
       FROM todos, json_each(todos.tags)
       WHERE todos.user_id = ? AND todos.bot_id = ? AND todos.status = 'open'
       GROUP BY json_each.value
       ORDER BY count DESC, tag ASC`,
		)
		.all(userId, botId) as TagCount[];
}

// ─── 支払い予定連携（§3.4.3） ────────────────────────────────────────────────

/** ToDo を支払い予定（planned_payments）に紐付ける */
export function linkPayment(
	userId: string,
	botId: string,
	todoId: number,
	paymentId: number,
): boolean {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE todos SET linked_payment_id = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ?`,
		)
		.run(paymentId, userId, botId, todoId);
	return result.changes > 0;
}

/**
 * 支払い予定の消込時に、紐付いた未完了ToDoを自動的に完了へ変更する（§3.4.3 消込フロー手順4）。
 * 完了に変更した TodoRecord の配列を返す（呼び出し元の finance モジュールが結果報告に利用できる）。
 */
export function completeTodoByPaymentLink(
	userId: string,
	botId: string,
	paymentId: number,
): TodoRecord[] {
	const db = getDb();
	const targets = db
		.prepare(
			`SELECT * FROM todos
       WHERE user_id = ? AND bot_id = ? AND linked_payment_id = ? AND status = 'open'`,
		)
		.all(userId, botId, paymentId) as TodoRecord[];
	if (targets.length === 0) return [];

	const stmt = db.prepare(
		`UPDATE todos SET status = 'done', updated_at = datetime('now', 'localtime')
     WHERE user_id = ? AND bot_id = ? AND id = ?`,
	);
	const completeAll = db.transaction((rows: TodoRecord[]) => {
		for (const row of rows) {
			stmt.run(userId, botId, row.id);
		}
	});
	completeAll(targets);

	return targets.map((t) => getTodoById(userId, botId, t.id)!).filter(Boolean);
}

// ─── 期限接近リマインド（cron用）（§3.3.1: タスク起因リマインド） ─────────────

/**
 * 期限が指定時間以内（期限超過・未リマインドを含む）の未完了ToDoを全ユーザー横断で取得する。
 * ※ cron 用の全件走査につき user_id スコープの例外（取得後の通知処理は各レコードの user_id 単位で行うこと）。
 * due_date は日付のみ・日時混在（ISO 8601）のため datetime() で正規化して比較する。
 */
export function listOpenTodosDueWithinAcrossUsers(hours: number): TodoRecord[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM todos
       WHERE status = 'open'
         AND due_reminded = 0
         AND due_date IS NOT NULL
         AND datetime(due_date) <= datetime('now', 'localtime', ?)
       ORDER BY datetime(due_date) ASC`,
		)
		.all(`+${Math.max(0, Math.floor(hours))} hours`) as TodoRecord[];
}

/**
 * 期限接近リマインドの送信済みフラグを立てる（重複通知防止）。
 * ※ cron（reminderEngine）が listOpenTodosDueWithinAcrossUsers で取得済みのレコードIDに対して
 *    呼び出す前提のため、user_id スコープの例外とする。
 */
export function markDueReminded(id: number): void {
	const db = getDb();
	db.prepare(
		`UPDATE todos SET due_reminded = 1, updated_at = datetime('now', 'localtime') WHERE id = ?`,
	).run(id);
}

// ─── ルーチン（繰り返し）タスク（§3.2 v16） ──────────────────────────────────

/**
 * 期日を過ぎた繰り返し（repeat_rule 付き）の親タスクを全ユーザー横断で取得する。
 * ※ cron（todoRecurrenceService）用の全件走査につき user_id スコープの例外。
 * サブタスク（parent_id あり）は対象外（ルーチンは親タスクのみ）。
 * status は問わない（完了済みでも未完了でも次回期日へ進める＝期日駆動）。
 */
export function listOverdueRoutinesAcrossUsers(): TodoRecord[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT * FROM todos
       WHERE repeat_rule IS NOT NULL
         AND parent_id IS NULL
         AND due_date IS NOT NULL
         AND datetime(due_date) <= datetime('now', 'localtime')
       ORDER BY datetime(due_date) ASC`,
		)
		.all() as TodoRecord[];
}

/**
 * ルーチンタスクを次回期日へ進める（期日駆動の自動更新）。
 * 同一行の due_date を nextDue へ更新し、状態・進捗・リマインド済みフラグをリセットして
 * 次サイクルを開始する（reminder の rescheduleRepeat と同方針＝行を増やさず山積みを防ぐ）。
 * nextCount（残り回数。NULL=無制限）を渡すと repeat_count を更新する。
 * ※ todoRecurrenceService が取得済みIDに対して呼ぶ前提のため user_id スコープの例外。
 */
export function advanceRoutine(
	id: number,
	nextDue: string,
	nextCount: number | null,
): TodoRecord | undefined {
	const db = getDb();
	db.prepare(
		`UPDATE todos SET
       due_date = ?,
       status = 'open',
       progress = 0,
       due_reminded = 0,
       repeat_count = ?,
       updated_at = datetime('now', 'localtime')
     WHERE id = ?`,
	).run(nextDue, nextCount, id);
	return db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as
		| TodoRecord
		| undefined;
}

/**
 * ルーチンを終了する（cron 用・id スコープ）。repeat_* をクリアして単発タスクに戻す。
 * 終了日超過・回数消化での自動終了に使う（現在の1件はそのまま残す）。
 * ※ todoRecurrenceService が取得済みIDに対して呼ぶ前提のため user_id スコープの例外。
 */
export function endRoutineById(id: number): void {
	const db = getDb();
	db.prepare(
		`UPDATE todos SET repeat_rule = NULL, repeat_until = NULL, repeat_count = NULL,
       updated_at = datetime('now', 'localtime')
     WHERE id = ?`,
	).run(id);
}

/**
 * ルーチンを終了する（終了指示）。repeat_* をクリアして通常の単発タスクに戻す。
 * タスク自体は削除しない（現在の1件はそのまま残る）。
 */
export function stopRoutine(
	userId: string,
	botId: string,
	id: number,
): TodoRecord | undefined {
	const db = getDb();
	const result = db
		.prepare(
			`UPDATE todos SET repeat_rule = NULL, repeat_until = NULL, repeat_count = NULL,
         updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ? AND repeat_rule IS NOT NULL`,
		)
		.run(userId, botId, id);
	return reloadIfChanged(result.changes, userId, botId, id);
}
