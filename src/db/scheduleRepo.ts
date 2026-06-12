import { getDb } from "./database.js";

// ─── 予定（Googleカレンダー同期）リポジトリ（§3.2） ──────────────────────────
// v2: user_id（DiscordユーザーID）スコープ。

export interface Schedule {
  id: number;
  user_id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string | null;
  remind_before_minutes: number;
  reminded: number;
  google_event_id: string | null;
  google_calendar_id: string | null;
  created_at: string;
}

/** reminderEngine 等から参照される別名（ピン留めコントラクト） */
export type ScheduleRecord = Schedule;

export function addSchedule(
  userId: string,
  title: string,
  startAt: string,
  endAt?: string,
  remindBeforeMinutes?: number,
  description?: string,
  googleEventId?: string,
  googleCalendarId?: string
): Schedule {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO schedules (user_id, title, description, start_at, end_at, remind_before_minutes, google_event_id, google_calendar_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    userId,
    title,
    description ?? null,
    startAt,
    endAt ?? null,
    remindBeforeMinutes ?? 10,
    googleEventId ?? null,
    googleCalendarId ?? null
  );
  return getScheduleById(result.lastInsertRowid as number)!;
}

export function listUpcomingSchedules(userId: string, days: number = 7): Schedule[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM schedules
       WHERE user_id = ? AND start_at >= datetime('now', 'localtime')
       AND start_at <= datetime('now', 'localtime', '+' || ? || ' days')
       ORDER BY start_at ASC`
    )
    .all(userId, days) as Schedule[];
}

/** 指定期間の予定一覧（日報・週報の集約用 §3.8.2） */
export function listSchedulesInRange(userId: string, from: string, to: string): Schedule[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM schedules
       WHERE user_id = ? AND start_at >= ? AND start_at <= ?
       ORDER BY start_at ASC`
    )
    .all(userId, from, to) as Schedule[];
}

export function getScheduleById(id: number): Schedule | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule | undefined;
}

export function getScheduleByGoogleId(googleEventId: string): Schedule | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM schedules WHERE google_event_id = ?").get(googleEventId) as Schedule | undefined;
}

export function getScheduleByTitleAndStart(userId: string, title: string, startAt: string): Schedule | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM schedules WHERE user_id = ? AND title = ? AND start_at = ?")
    .get(userId, title, startAt) as Schedule | undefined;
}

export function linkGoogleEventId(id: number, googleEventId: string, googleCalendarId?: string): void {
  const db = getDb();
  db.prepare("UPDATE schedules SET google_event_id = ?, google_calendar_id = ? WHERE id = ?")
    .run(googleEventId, googleCalendarId ?? null, id);
}

export function updateScheduleFromGoogle(
  id: number,
  title: string,
  startAt: string,
  endAt: string | null,
  description: string | null,
  googleCalendarId?: string
): void {
  const db = getDb();
  db.prepare(`
    UPDATE schedules
    SET title = ?, start_at = ?, end_at = ?, description = ?, google_calendar_id = ?, reminded = 0
    WHERE id = ?
  `).run(title, startAt, endAt, description, googleCalendarId ?? null, id);
}

export function listAllFutureSchedulesWithGoogleId(userId: string): Schedule[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM schedules WHERE user_id = ? AND google_event_id IS NOT NULL AND start_at >= datetime('now', 'localtime')")
    .all(userId) as Schedule[];
}

/**
 * リマインド未送信の予定を取得する（cron用・全ユーザー横断の例外クエリ。
 * reminderEngine が user_id 単位で通知先を解決して送信する）
 */
export function getUnremindedSchedules(): Schedule[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM schedules
       WHERE reminded = 0
       AND datetime(start_at, '-' || remind_before_minutes || ' minutes') <= datetime('now', 'localtime')
       AND start_at >= datetime('now', 'localtime', '-2 minutes')`
    )
    .all() as Schedule[];
}

export function markReminded(id: number): void {
  const db = getDb();
  db.prepare("UPDATE schedules SET reminded = 1 WHERE id = ?").run(id);
}

export function deleteSchedule(id: number, userId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ?").run(id, userId);
  return result.changes > 0;
}
