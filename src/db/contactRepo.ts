import { getDb } from "./database.js";

// ─── 連絡先管理（§3.11） ─────────────────────────────────────────────────────
// 人物ごとのメモ（誕生日・関係性・連絡先・特記事項）を構造化して記録する。
// LLMコンテキストへは常時注入せず、言及時に動的注入する（§3.11.3）。

export interface ContactRecord {
  id: number;
  user_id: string;
  name: string;
  birthday: string | null; // 'YYYY-MM-DD' または '--MM-DD'（年不明）
  relationship: string | null;
  contact_info: string | null;
  notes: string | null;
  tags: string; // JSON string[]
  birthday_reminded_year: number | null;
  created_at: string;
  updated_at: string;
}

export interface ContactInput {
  name: string;
  birthday?: string | null;
  relationship?: string | null;
  contactInfo?: string | null;
  notes?: string | null;
  tags?: string[];
}

/** birthday の形式検証（'YYYY-MM-DD' または '--MM-DD'） */
export function isValidBirthday(birthday: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(birthday) || /^--\d{2}-\d{2}$/.test(birthday);
}

export function addContact(userId: string, input: ContactInput): ContactRecord {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO contacts (user_id, name, birthday, relationship, contact_info, notes, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      input.name,
      input.birthday ?? null,
      input.relationship ?? null,
      input.contactInfo ?? null,
      input.notes ?? null,
      JSON.stringify(input.tags ?? [])
    );
  return getContactById(userId, Number(result.lastInsertRowid))!;
}

export function getContactById(userId: string, id: number): ContactRecord | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM contacts WHERE user_id = ? AND id = ?")
    .get(userId, id) as ContactRecord | undefined;
}

export function updateContact(
  userId: string,
  id: number,
  input: Partial<ContactInput>
): boolean {
  const current = getContactById(userId, id);
  if (!current) return false;
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE contacts SET
         name = ?, birthday = ?, relationship = ?, contact_info = ?, notes = ?, tags = ?,
         updated_at = datetime('now', 'localtime')
       WHERE user_id = ? AND id = ?`
    )
    .run(
      input.name ?? current.name,
      input.birthday !== undefined ? input.birthday : current.birthday,
      input.relationship !== undefined ? input.relationship : current.relationship,
      input.contactInfo !== undefined ? input.contactInfo : current.contact_info,
      input.notes !== undefined ? input.notes : current.notes,
      input.tags !== undefined ? JSON.stringify(input.tags) : current.tags,
      userId,
      id
    );
  return result.changes > 0;
}

export function deleteContact(userId: string, id: number): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM contacts WHERE user_id = ? AND id = ?").run(userId, id);
  return result.changes > 0;
}

/** 氏名・関係性・メモの部分一致検索 */
export function searchContacts(userId: string, query: string): ContactRecord[] {
  const db = getDb();
  const like = `%${query.replace(/[%_]/g, (c) => "\\" + c)}%`;
  return db
    .prepare(
      `SELECT * FROM contacts
       WHERE user_id = ?
         AND (name LIKE ? ESCAPE '\\' OR relationship LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
       ORDER BY name ASC`
    )
    .all(userId, like, like, like, like) as ContactRecord[];
}

export function listContacts(userId: string): ContactRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM contacts WHERE user_id = ? ORDER BY name ASC")
    .all(userId) as ContactRecord[];
}

/**
 * 「明日」が誕生日の連絡先を全ユーザー横断で取得する（cron用例外クエリ §3.11.2 誕生日リマインド）
 * birthday_reminded_year により同一年の重複通知を防ぐ。
 * @param tomorrowMonthDay 'MM-DD' 形式
 * @param currentYear 重複判定に使う年
 */
export function listBirthdayContactsForDate(
  tomorrowMonthDay: string,
  currentYear: number
): ContactRecord[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM contacts
       WHERE birthday IS NOT NULL
         AND (substr(birthday, -5) = ?)
         AND (birthday_reminded_year IS NULL OR birthday_reminded_year < ?)`
    )
    .all(tomorrowMonthDay, currentYear) as ContactRecord[];
}

export function markBirthdayReminded(id: number, year: number): void {
  const db = getDb();
  db.prepare("UPDATE contacts SET birthday_reminded_year = ? WHERE id = ?").run(year, id);
}
