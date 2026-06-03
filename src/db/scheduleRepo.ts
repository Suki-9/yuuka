import { getDb } from "./database.js";

export interface Schedule {
  id: number;
  bot_id: string;
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

export function addSchedule(
  botId: string,
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
    INSERT INTO schedules (bot_id, title, description, start_at, end_at, remind_before_minutes, google_event_id, google_calendar_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    botId,
    title,
    description ?? null,
    startAt,
    endAt ?? null,
    remindBeforeMinutes ?? 30,
    googleEventId ?? null,
    googleCalendarId ?? null
  );
  return getScheduleById(result.lastInsertRowid as number)!;
}

export function listUpcomingSchedules(botId: string, days: number = 7): Schedule[] {
  const db = getDb();
  return db
    .prepare
    (
      `SELECT * FROM schedules 
       WHERE bot_id = ? AND start_at >= datetime('now', 'localtime')
       AND start_at <= datetime('now', 'localtime', '+' || ? || ' days')
       ORDER BY start_at ASC`
    )
    .all(botId, days) as Schedule[];
}

export function getScheduleById(id: number): Schedule | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Schedule | undefined;
}

export function getScheduleByGoogleId(googleEventId: string): Schedule | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM schedules WHERE google_event_id = ?").get(googleEventId) as Schedule | undefined;
}

export function getScheduleByTitleAndStart(botId: string, title: string, startAt: string): Schedule | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM schedules WHERE bot_id = ? AND title = ? AND start_at = ?")
    .get(botId, title, startAt) as Schedule | undefined;
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

export function listAllFutureSchedulesWithGoogleId(botId: string): Schedule[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM schedules WHERE bot_id = ? AND google_event_id IS NOT NULL AND start_at >= datetime('now', 'localtime')")
    .all(botId) as Schedule[];
}

export function getUnremindedSchedules(): Schedule[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM schedules 
       WHERE reminded = 0 
       AND datetime(start_at, '-' || remind_before_minutes || ' minutes') <= datetime('now', 'localtime')
       AND start_at >= datetime('now', 'localtime')`
    )
    .all() as Schedule[];
}

export function markReminded(id: number): void {
  const db = getDb();
  db.prepare("UPDATE schedules SET reminded = 1 WHERE id = ?").run(id);
}

export function deleteSchedule(id: number, botId: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM schedules WHERE id = ? AND bot_id = ?").run(id, botId);
  return result.changes > 0;
}
