import * as scheduleRepo from "../db/scheduleRepo.js";
import { formatDateTime } from "../utils/formatters.js";
import { 
  isCalendarEnabled, 
  createCalendarEvent, 
  deleteCalendarEvent, 
  syncGoogleCalendarToLocal 
} from "../services/googleCalendarService.js";

export async function addSchedule(
  userId: string,
  args: {
    title: string;
    start_at: string;
    end_at?: string;
    remind_before_minutes?: number;
    description?: string;
    calendar_id?: string;
    local_only?: boolean;
  }
): Promise<string> {
  let googleEventId: string | undefined = undefined;
  let googleCalendarId: string | undefined = undefined;

  if (isCalendarEnabled(userId) && !args.local_only) {
    try {
      const eventResult = await createCalendarEvent(
        userId,
        args.title,
        args.start_at,
        args.end_at,
        args.description,
        args.calendar_id
      );
      if (eventResult) {
        googleEventId = eventResult.eventId;
        googleCalendarId = eventResult.calendarId;
      }
    } catch (err) {
      console.error("予定追加時のGoogleカレンダー同期に失敗しました:", err);
    }
  }

  const schedule = scheduleRepo.addSchedule(
    userId,
    args.title,
    args.start_at,
    args.end_at,
    args.remind_before_minutes,
    args.description,
    googleEventId,
    googleCalendarId
  );

  const remindLabel =
    schedule.remind_before_minutes > 0
      ? `、${schedule.remind_before_minutes}分前にリマインド`
      : "";

  const syncMessage = googleEventId
    ? "（Googleカレンダーにも同期しました📅）"
    : (isCalendarEnabled(userId) ? "（ローカルリマインダーとして登録しました🔔）" : "");

  return JSON.stringify({
    success: true,
    message: `予定「${schedule.title}」を登録しました (${formatDateTime(schedule.start_at)}${remindLabel})${syncMessage}`,
    schedule,
  });
}

export async function listSchedules(
  userId: string,
  args: { days?: number }
): Promise<string> {
  const days = args.days ?? 7;

  // Googleカレンダー同期を実行して最新情報をマージ
  if (isCalendarEnabled(userId)) {
    try {
      // 7日表示の場合は、余裕を持って30日間を取得同期する
      const syncDays = Math.max(days, 30);
      await syncGoogleCalendarToLocal(userId, syncDays);
    } catch (err) {
      console.error("予定取得前のGoogleカレンダー同期に失敗しました:", err);
    }
  }

  const schedules = scheduleRepo.listUpcomingSchedules(userId, days);
  if (schedules.length === 0) {
    return JSON.stringify({
      success: true,
      message: `今後${days}日間の予定はありません。`,
      schedules: [],
    });
  }

  const lines = schedules.map(
    (s) => {
      const googleIcon = s.google_event_id ? "📅" : "📌";
      return `${googleIcon} #${s.id} ${s.title} — ${formatDateTime(s.start_at)}`;
    }
  );

  return JSON.stringify({
    success: true,
    message: `今後${days}日間の予定 (${schedules.length}件):\n${lines.join("\n")}`,
    schedules,
  });
}

export async function deleteSchedule(
  userId: string,
  args: { schedule_id: number }
): Promise<string> {
  const schedule = scheduleRepo.getScheduleById(args.schedule_id);
  if (!schedule || schedule.user_id !== userId) {
    return JSON.stringify({
      success: false,
      message: `予定 #${args.schedule_id} が見つかりません。`,
    });
  }

  // Googleカレンダーからも削除
  if (isCalendarEnabled(userId) && schedule.google_event_id) {
    try {
      await deleteCalendarEvent(userId, schedule.google_event_id, schedule.google_calendar_id || undefined);
    } catch (err) {
      console.error(`予定削除時のGoogleカレンダー同期に失敗しました (EventID: ${schedule.google_event_id}):`, err);
    }
  }

  const deleted = scheduleRepo.deleteSchedule(args.schedule_id, userId);
  if (!deleted) {
    return JSON.stringify({
      success: false,
      message: `予定 #${args.schedule_id} の削除に失敗しました。`,
    });
  }

  return JSON.stringify({
    success: true,
    message: `予定 #${args.schedule_id} を削除しました🗑️`,
  });
}
