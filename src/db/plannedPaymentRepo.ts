import { getDb } from "./database.js";

// ─── 支払い予定 リポジトリ（§3.4.3） ─────────────────────────────────────────
//
// planned_payments テーブル（スキーマ定義は db/migrations.ts が唯一の定義元）への永続化層。
// データ分離の原則: 全クエリは user_id (DiscordユーザーID) を WHERE 必須条件とする。
// 例外は cron（paymentRecurrenceService）用の全件走査
// （listPendingDueWithinAcrossUsers / listOverdueRecurringAcrossUsers / advanceRecurring）のみ。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

export type PlannedPaymentStatus = "pending" | "settled" | "cancelled";

/** planned_payments テーブルの1レコード（§3.4.4 PlannedPayment） */
export interface PlannedPaymentRecord {
  id: number;
  user_id: string;
  title: string;
  amount: number;
  category: string;
  memo: string | null;
  /** 支払い期日 'YYYY-MM-DD' */
  due_date: string;
  /** 繰り返し支払い（家賃・サブスク等）の cron式。単発は NULL */
  repeat_rule: string | null;
  status: PlannedPaymentStatus;
  /** 消込した Expense の ID（§3.4.3 消込フロー） */
  settled_expense_id: number | null;
  /** 紐付きToDoのID（§3.4.3 ToDo連携） */
  linked_todo_id: number | null;
  /** 紐付きリマインドのID（§3.4.3 リマインド連携） */
  linked_reminder_id: number | null;
  created_at: string;
  updated_at: string;
}

/** addPlannedPayment の入力 */
export interface PlannedPaymentInput {
  title: string;
  amount: number;
  category: string;
  /** 'YYYY-MM-DD' */
  dueDate: string;
  memo?: string;
  /** cron式（繰り返し支払いの場合のみ） */
  repeatRule?: string;
}

/** listPlannedPayments のフィルタ条件 */
export interface PlannedPaymentListFilter {
  /** ステータス絞り込み（既定 'pending'） */
  status?: PlannedPaymentStatus | "all";
}

/** findSettlementCandidates の照合条件（実際の支払い記録の内容） */
export interface SettlementQuery {
  amount: number;
  category: string;
  /** 実際の支払い日 'YYYY-MM-DD' */
  date: string;
}

// ─── 登録・取得 ──────────────────────────────────────────────────────────────

/** 支払い予定を登録する（§3.4.3: 自然言語からLLMが構造化した内容を保存） */
export function addPlannedPayment(
  userId: string,
  input: PlannedPaymentInput
): PlannedPaymentRecord {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO planned_payments (user_id, title, amount, category, memo, due_date, repeat_rule)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      input.title,
      input.amount,
      input.category,
      input.memo ?? null,
      input.dueDate,
      input.repeatRule ?? null
    );
  return getPlannedPaymentById(userId, result.lastInsertRowid as number)!;
}

/** ID指定で1件取得する（本人の予定のみ） */
export function getPlannedPaymentById(
  userId: string,
  id: number
): PlannedPaymentRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM planned_payments WHERE user_id = ? AND id = ?")
    .get(userId, id) as PlannedPaymentRecord | undefined;
}

/** 支払い予定一覧を取得する（既定は pending のみ、期日の近い順） */
export function listPlannedPayments(
  userId: string,
  filter: PlannedPaymentListFilter = {}
): PlannedPaymentRecord[] {
  const db = getDb();
  const status = filter.status ?? "pending";
  if (status === "all") {
    return db
      .prepare(
        `SELECT * FROM planned_payments WHERE user_id = ?
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, due_date ASC, id ASC`
      )
      .all(userId) as PlannedPaymentRecord[];
  }
  return db
    .prepare(
      `SELECT * FROM planned_payments WHERE user_id = ? AND status = ?
       ORDER BY due_date ASC, id ASC`
    )
    .all(userId, status) as PlannedPaymentRecord[];
}

// ─── 消込・キャンセル（§3.4.3 消込フロー） ──────────────────────────────────

/**
 * 支払い予定を消込する（status='settled' + settled_expense_id 記録。pending のみ対象）。
 * @returns 消込後のレコード。対象が存在しない（または pending でない）場合は undefined
 */
export function settlePlannedPayment(
  userId: string,
  id: number,
  expenseId: number
): PlannedPaymentRecord | undefined {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE planned_payments
       SET status = 'settled', settled_expense_id = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND id = ? AND status = 'pending'`
    )
    .run(expenseId, userId, id);
  if (result.changes === 0) return undefined;
  return getPlannedPaymentById(userId, id);
}

/**
 * 支払い予定をキャンセルする（pending のみ対象。繰り返し予定もこの行で自動生成が止まる）。
 * @returns キャンセル後のレコード。対象が存在しない（または pending でない）場合は undefined
 */
export function cancelPlannedPayment(
  userId: string,
  id: number
): PlannedPaymentRecord | undefined {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE planned_payments
       SET status = 'cancelled', updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND id = ? AND status = 'pending'`
    )
    .run(userId, id);
  if (result.changes === 0) return undefined;
  return getPlannedPaymentById(userId, id);
}

// ─── ToDo・リマインド連携（§3.4.3） ─────────────────────────────────────────

/** 生成したToDoのIDを支払い予定へ紐付ける */
export function linkTodo(userId: string, id: number, todoId: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE planned_payments
       SET linked_todo_id = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND id = ?`
    )
    .run(todoId, userId, id);
  return result.changes > 0;
}

/** 生成したリマインドのIDを支払い予定へ紐付ける */
export function linkReminder(userId: string, id: number, reminderId: number): boolean {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE planned_payments
       SET linked_reminder_id = ?, updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND id = ?`
    )
    .run(reminderId, userId, id);
  return result.changes > 0;
}

// ─── 消込自動照合（§3.4.3 消込フロー手順2） ─────────────────────────────────

/**
 * 実際の支払い記録に対応しそうな pending の支払い予定（消込候補）を検索する。
 * 照合条件: 金額±10%・同カテゴリ・期日が支払い日の±7日以内。
 * 期日が支払い日に近い順 → 金額が近い順に返す。
 */
export function findSettlementCandidates(
  userId: string,
  query: SettlementQuery
): PlannedPaymentRecord[] {
  const db = getDb();
  const lower = Math.floor(query.amount * 0.9);
  const upper = Math.ceil(query.amount * 1.1);
  return db
    .prepare(
      `SELECT * FROM planned_payments
       WHERE user_id = ? AND status = 'pending'
         AND category = ?
         AND amount BETWEEN ? AND ?
         AND date(due_date) BETWEEN date(?, '-7 days') AND date(?, '+7 days')
       ORDER BY ABS(julianday(date(due_date)) - julianday(date(?))) ASC,
                ABS(amount - ?) ASC`
    )
    .all(
      userId,
      query.category,
      lower,
      upper,
      query.date,
      query.date,
      query.date,
      query.amount
    ) as PlannedPaymentRecord[];
}

// ─── cron用クエリ（paymentRecurrenceService / レポート系） ───────────────────

/**
 * 期日が指定日数以内（期日超過を含む）の pending 予定を全ユーザー横断で取得する。
 * ※ cron 用の全件走査につき user_id スコープの例外
 *   （取得後の処理は各レコードの user_id 単位で行うこと）。
 */
export function listPendingDueWithinAcrossUsers(days: number): PlannedPaymentRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM planned_payments
       WHERE status = 'pending'
         AND date(due_date) <= date('now', 'localtime', ?)
       ORDER BY due_date ASC, id ASC`
    )
    .all(`+${Math.max(0, Math.floor(days))} days`) as PlannedPaymentRecord[];
}

/**
 * repeat_rule 付きで期日を過ぎた（昨日以前が期日の）pending 予定を全ユーザー横断で取得する。
 * paymentRecurrenceService が次回予定の自動生成（§3.4.3）に使用する。
 * ※ cron 用の全件走査につき user_id スコープの例外。
 */
export function listOverdueRecurringAcrossUsers(): PlannedPaymentRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM planned_payments
       WHERE status = 'pending'
         AND repeat_rule IS NOT NULL
         AND date(due_date) < date('now', 'localtime')
       ORDER BY due_date ASC, id ASC`
    )
    .all() as PlannedPaymentRecord[];
}

/**
 * 繰り返し支払い予定の次回分を生成する（§3.4.3: 自動次回生成）。
 * 元の行がまだ pending なら処理済み（settled）へ変更した上で、
 * title/amount/category/memo/repeat_rule を引き継いだ新しい pending 行を作る方式。
 * （settled/cancelled 済みの行はステータスを変えずに次回行のみ生成する。
 *   消込時の次回生成＝financeFunctions.settlePlannedPayment からの呼び出しに対応）
 * ※ cron（paymentRecurrenceService）からも呼ばれるため、例外的に user_id 引数なし
 *   （id は呼び出し元が本人スコープ or 全件走査で解決済みの前提）。
 * @returns 生成された次回分のレコード。元の行が存在しない場合は undefined
 */
export function advanceRecurring(
  id: number,
  nextDueDate: string
): PlannedPaymentRecord | undefined {
  const db = getDb();
  const original = db
    .prepare("SELECT * FROM planned_payments WHERE id = ?")
    .get(id) as PlannedPaymentRecord | undefined;
  if (!original) return undefined;

  const advance = db.transaction((): number => {
    // 元の行が pending のままなら処理済みにする（期日超過の自動送り）
    db.prepare(
      `UPDATE planned_payments
       SET status = 'settled', updated_at = datetime('now', 'localtime')
       WHERE id = ? AND status = 'pending'`
    ).run(id);

    // 次回分の pending 行を生成（ToDo/リマインドの紐付けは引き継がない）
    const result = db
      .prepare(
        `INSERT INTO planned_payments (user_id, title, amount, category, memo, due_date, repeat_rule)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        original.user_id,
        original.title,
        original.amount,
        original.category,
        original.memo,
        nextDueDate,
        original.repeat_rule
      );
    return result.lastInsertRowid as number;
  });

  const newId = advance();
  return db
    .prepare("SELECT * FROM planned_payments WHERE id = ?")
    .get(newId) as PlannedPaymentRecord;
}
