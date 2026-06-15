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
  priority: TodoPriority | null;
  tags: string;
  status: "open" | "done";
  linked_payment_id: number | null;
  due_reminded: number;
  created_at: string;
  updated_at: string;
}

/** addTodo の入力 */
export interface TodoInput {
  title: string;
  description?: string;
  dueDate?: string;
  priority?: TodoPriority;
  tags?: string[];
}

/** updateTodo の入力（指定されたフィールドのみ更新） */
export interface TodoUpdateInput {
  title?: string;
  description?: string;
  dueDate?: string;
  priority?: TodoPriority;
  status?: "open" | "done";
}

/** listTodos のフィルタ条件 */
export interface TodoListFilter {
  /** ステータス絞り込み（デフォルト 'open'） */
  status?: "open" | "done" | "all";
  /** 指定タグを持つToDoのみ（§3.2.4: グループ別表示） */
  tag?: string;
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

/** ToDo を追加する（タグは省略時は空配列。LLMによる自動付与は autoTagService が後追いで行う） */
export function addTodo(userId: string, botId: string, input: TodoInput): TodoRecord {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO todos (user_id, bot_id, title, description, due_date, priority, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      botId,
      input.title,
      input.description ?? null,
      input.dueDate ?? null,
      input.priority ?? null,
      JSON.stringify(input.tags ?? [])
    );
  return getTodoById(userId, botId, result.lastInsertRowid as number)!;
}

/** ID指定で1件取得する（本人のToDoのみ） */
export function getTodoById(userId: string, botId: string, id: number): TodoRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM todos WHERE user_id = ? AND bot_id = ? AND id = ?")
    .get(userId, botId, id) as TodoRecord | undefined;
}

/**
 * ToDo 一覧を取得する（§3.2.1: 未完了・完了済み・タグ別表示）。
 * tag 指定時は tags JSON 配列に該当タグを含むもののみ返す（json_each で展開して照合）。
 */
export function listTodos(userId: string, botId: string, filter: TodoListFilter = {}): TodoRecord[] {
  const db = getDb();
  const status = filter.status ?? "open";

  const conditions: string[] = ["user_id = ?", "bot_id = ?"];
  const params: unknown[] = [userId, botId];

  if (status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }
  if (filter.tag) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(todos.tags) WHERE json_each.value = ?)");
    params.push(filter.tag);
  }

  return db
    .prepare(`SELECT * FROM todos WHERE ${conditions.join(" AND ")} ${ORDER_CLAUSE}`)
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
  input: TodoUpdateInput
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
    sets.push("due_date = ?", "due_reminded = 0");
    params.push(input.dueDate);
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
    .prepare(`UPDATE todos SET ${sets.join(", ")} WHERE user_id = ? AND bot_id = ? AND id = ?`)
    .run(...params, userId, botId, id);
  if (result.changes === 0) return undefined;
  return getTodoById(userId, botId, id);
}

/** タグを上書き保存する（§3.2.4: LLM自動付与の保存先。autoTagService から呼ばれる） */
export function updateTodoTags(userId: string, botId: string, id: number, tags: string[]): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE todos SET tags = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ?`
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
  items: { id: number; priority: TodoPriority }[]
): number {
  const db = getDb();
  const stmt = db.prepare(
    `UPDATE todos SET priority = ?, updated_at = datetime('now', 'localtime')
     WHERE user_id = ? AND bot_id = ? AND id = ? AND status = 'open'`
  );
  const applyAll = db.transaction((rows: { id: number; priority: TodoPriority }[]) => {
    let updated = 0;
    for (const row of rows) {
      updated += stmt.run(row.priority, userId, botId, row.id).changes;
    }
    return updated;
  });
  return applyAll(items);
}

/** ToDo を完了にする */
export function completeTodo(userId: string, botId: string, id: number): TodoRecord | undefined {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE todos SET status = 'done', updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ?`
    )
    .run(userId, botId, id);
  if (result.changes === 0) return undefined;
  return getTodoById(userId, botId, id);
}

/** ToDo を削除する */
export function deleteTodo(userId: string, botId: string, id: number): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM todos WHERE user_id = ? AND bot_id = ? AND id = ?")
    .run(userId, botId, id);
  return result.changes > 0;
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
       ORDER BY count DESC, tag ASC`
    )
    .all(userId, botId) as TagCount[];
}

// ─── 支払い予定連携（§3.4.3） ────────────────────────────────────────────────

/** ToDo を支払い予定（planned_payments）に紐付ける */
export function linkPayment(userId: string, botId: string, todoId: number, paymentId: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE todos SET linked_payment_id = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND bot_id = ? AND id = ?`
    )
    .run(paymentId, userId, botId, todoId);
  return result.changes > 0;
}

/**
 * 支払い予定の消込時に、紐付いた未完了ToDoを自動的に完了へ変更する（§3.4.3 消込フロー手順4）。
 * 完了に変更した TodoRecord の配列を返す（呼び出し元の finance モジュールが結果報告に利用できる）。
 */
export function completeTodoByPaymentLink(userId: string, botId: string, paymentId: number): TodoRecord[] {
  const db = getDb();
  const targets = db
    .prepare(
      `SELECT * FROM todos
       WHERE user_id = ? AND bot_id = ? AND linked_payment_id = ? AND status = 'open'`
    )
    .all(userId, botId, paymentId) as TodoRecord[];
  if (targets.length === 0) return [];

  const stmt = db.prepare(
    `UPDATE todos SET status = 'done', updated_at = datetime('now', 'localtime')
     WHERE user_id = ? AND bot_id = ? AND id = ?`
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
       ORDER BY datetime(due_date) ASC`
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
    `UPDATE todos SET due_reminded = 1, updated_at = datetime('now', 'localtime') WHERE id = ?`
  ).run(id);
}
