import { google, Auth } from "googleapis";
import * as scheduleRepo from "../db/scheduleRepo.js";
import { getUserGoogleConfig } from "../db/userRepo.js";
import { decryptText } from "../utils/crypto.js";
import { config } from "../config.js";

// ─── Google Calendar 連携（§3.2.2: OAuth 2.0 によりユーザー毎に認証） ────────
// v2: OAuth情報は users テーブル（ユーザー単位）から取得する。
// Client ID / Secret はシステム共通設定（config.googleClientId/Secret）を使用する。

/** ユーザーの復号済みリフレッシュトークンを取得する（未連携なら null） */
function getDecryptedRefreshToken(userId: string): string | null {
  const googleConfig = getUserGoogleConfig(userId);
  if (
    !googleConfig ||
    !googleConfig.refreshTokenEncrypted ||
    !googleConfig.refreshTokenIv ||
    !googleConfig.refreshTokenTag
  ) {
    return null;
  }
  try {
    return decryptText(
      googleConfig.refreshTokenEncrypted,
      googleConfig.refreshTokenIv,
      googleConfig.refreshTokenTag
    );
  } catch (err) {
    console.error(`ユーザー ${userId} のGoogleリフレッシュトークンの復号に失敗しました:`, err);
    return null;
  }
}

/**
 * ユーザー別の Google OAuth2 認証クライアントを取得（Calendar / Drive 共用）
 */
export function getOAuthClientForUser(userId: string): Auth.OAuth2Client | null {
  const refreshToken = getDecryptedRefreshToken(userId);
  if (!config.googleClientId || !config.googleClientSecret || !refreshToken) {
    return null;
  }
  try {
    const auth = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
    auth.setCredentials({ refresh_token: refreshToken });
    return auth;
  } catch (error) {
    console.error("Google OAuth2 認証クライアントの初期化に失敗しました:", error);
    return null;
  }
}

/**
 * ユーザー別の Google Calendar API クライアントを取得
 */
function getCalendarClient(userId: string) {
  const auth = getOAuthClientForUser(userId);
  if (!auth) return null;
  return google.calendar({ version: "v3", auth });
}

/**
 * ユーザーのGoogleカレンダー連携が有効かどうかを判定
 */
export function isCalendarEnabled(userId: string): boolean {
  return getCalendarClient(userId) !== null;
}

/**
 * ユーザーの利用可能なカレンダーの一覧をGoogle APIから取得する
 */
export async function fetchAvailableCalendars(userId: string): Promise<{ id: string; summary: string }[]> {
  const calendar = getCalendarClient(userId);
  if (!calendar) return [];

  const googleConfig = getUserGoogleConfig(userId);
  if (!googleConfig) return [];

  // 1. ユーザー設定に同期対象カレンダーが指定されている場合はそちらを最優先
  const selectedCalendarIds = googleConfig.calendars || [];

  if (selectedCalendarIds.length > 0) {
    const list: { id: string; summary: string }[] = [];
    for (const id of selectedCalendarIds) {
      try {
        const response = await calendar.calendars.get({ calendarId: id });
        if (response.data.summary) {
          list.push({ id, summary: response.data.summary });
        }
      } catch (err) {
        console.error(`カレンダー情報取得失敗 (${id}):`, err);
        // 取得に失敗してもIDと最低限の仮名を設定しておく
        list.push({ id, summary: id === googleConfig.calendarId ? "メインカレンダー" : `カレンダー (${id})` });
      }
    }
    return list;
  }

  // 2. 指定がない場合は calendarList.list をフォールバックとして試行
  try {
    const response = await calendar.calendarList.list({
      minAccessRole: "writer", // 書き込み権限があるもののみ（予定の追加・削除用）
    });

    const list = (response.data.items || [])
      .filter((item) => item.id && item.summary)
      .map((item) => ({
        id: item.id!,
        summary: item.summary!,
      }));

    // デフォルトカレンダーが入っていなければ追加
    if (googleConfig.calendarId && !list.some(item => item.id === googleConfig.calendarId)) {
      try {
        const primaryRes = await calendar.calendars.get({ calendarId: googleConfig.calendarId });
        list.unshift({ id: googleConfig.calendarId, summary: primaryRes.data.summary || "デフォルトカレンダー" });
      } catch {
        list.unshift({ id: googleConfig.calendarId, summary: "デフォルトカレンダー" });
      }
    }
    return list;
  } catch (error) {
    console.error("カレンダー一覧の取得に失敗しました:", error);
    // 失敗した場合は最低限、デフォルトのカレンダー情報を返す
    if (googleConfig.calendarId) {
      return [{ id: googleConfig.calendarId, summary: "デフォルトカレンダー" }];
    }
    return [];
  }
}

// ユーザー別キャッシュ
const cachedCalendarsMap = new Map<string, { calendars: { id: string; summary: string }[]; lastFetched: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5分キャッシュ

// 期限切れエントリの定期掃除（TTL超過後も Map に残り続けるとユーザー数に比例して増え続ける）
const calendarCacheSweep = setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of cachedCalendarsMap) {
    if (now - entry.lastFetched >= CACHE_TTL) cachedCalendarsMap.delete(userId);
  }
}, 30 * 60 * 1000);
calendarCacheSweep.unref();

/**
 * ユーザー別のキャッシュ付きで利用可能なカレンダーの一覧を返す
 */
export async function getCachedCalendars(userId: string): Promise<{ id: string; summary: string }[]> {
  const now = Date.now();
  const cached = cachedCalendarsMap.get(userId);
  if (cached && cached.calendars.length > 0 && now - cached.lastFetched < CACHE_TTL) {
    return cached.calendars;
  }
  const calendars = await fetchAvailableCalendars(userId);
  cachedCalendarsMap.set(userId, { calendars, lastFetched: now });
  return calendars;
}

/** カレンダー一覧キャッシュを無効化する（OAuth再連携・同期対象変更時に呼ぶ） */
export function invalidateCalendarCache(userId: string): void {
  cachedCalendarsMap.delete(userId);
}

/**
 * ISO 8601日時文字列をローカル日時形式（YYYY-MM-DD HH:mm:ss）に変換
 */
function formatToLocalString(isoOrDateStr: string): string {
  const d = new Date(isoOrDateStr);
  if (isNaN(d.getTime())) {
    throw new Error(`不正な日付フォーマットです: ${isoOrDateStr}`);
  }
  const pad = (n: number) => n.toString().padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const date = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
}

/**
 * ローカルの日時文字列（YYYY-MM-DD HH:mm:ss）を ISO 8601形式に変換
 */
function formatToISOString(localStr: string): string {
  const d = new Date(localStr.replace(" ", "T"));
  return d.toISOString();
}

/**
 * Googleカレンダーにイベントを作成
 */
export async function createCalendarEvent(
  userId: string,
  title: string,
  startAt: string,
  endAt?: string,
  description?: string,
  calendarId?: string
): Promise<{ eventId: string; calendarId: string } | null> {
  const calendar = getCalendarClient(userId);
  if (!calendar) return null;

  const googleConfig = getUserGoogleConfig(userId);
  if (!googleConfig) return null;

  try {
    const isoStart = formatToISOString(startAt);
    // 終了時刻がない場合は開始から1時間後を設定
    const isoEnd = endAt
      ? formatToISOString(endAt)
      : new Date(new Date(isoStart).getTime() + 60 * 60 * 1000).toISOString();

    const targetCalendarId = calendarId || googleConfig.calendarId || "";

    const response = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: {
        summary: title,
        description: description || "",
        start: {
          dateTime: isoStart,
        },
        end: {
          dateTime: isoEnd,
        },
      },
    });

    if (response.data.id) {
      return {
        eventId: response.data.id,
        calendarId: targetCalendarId,
      };
    }
    return null;
  } catch (error) {
    console.error("Googleカレンダーのイベント作成に失敗しました:", error);
    return null;
  }
}

/**
 * Googleカレンダーのイベントを削除
 */
export async function deleteCalendarEvent(userId: string, eventId: string, calendarId?: string): Promise<boolean> {
  const calendar = getCalendarClient(userId);
  if (!calendar) return false;

  const googleConfig = getUserGoogleConfig(userId);

  try {
    const targetCalendarId = calendarId || googleConfig?.calendarId || "";
    await calendar.events.delete({
      calendarId: targetCalendarId,
      eventId: eventId,
    });
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      return true;
    }
    console.error(`Googleカレンダーのイベント削除に失敗しました (EventID: ${eventId}, CalendarID: ${calendarId}):`, error);
    return false;
  }
}

/**
 * すべての利用可能カレンダーとローカルDBの双方向同期を実行する
 */
export async function syncGoogleCalendarToLocal(
  userId: string,
  daysWindow: number = 30
): Promise<void> {
  const calendar = getCalendarClient(userId);
  if (!calendar) return;

  try {
    const calendars = await getCachedCalendars(userId);
    console.log(`🔄 Googleカレンダー同期中... (対象ユーザー: ${userId}, カレンダー数: ${calendars.length})`);

    const now = new Date();
    // 1日前から同期ウィンドウの終わりまでを取得
    const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const timeMax = new Date(now.getTime() + daysWindow * 24 * 60 * 60 * 1000).toISOString();

    // Googleカレンダー連携はユーザー全体の統合機能のため、同期される予定は
    // デフォルト秘書（system_default）に帰属させる（秘書業務データのBot別分離 §v3）。
    const SYNC_BOT_ID = "system_default";

    // 1. ローカルの該当期間内の「Google同期済み予定」をマップとして取得
    const localSchedules = scheduleRepo.listAllFutureSchedulesWithGoogleId(userId, SYNC_BOT_ID);
    const localMap = new Map<string, scheduleRepo.Schedule>();
    for (const s of localSchedules) {
      if (s.google_event_id) {
        localMap.set(s.google_event_id, s);
      }
    }

    // 2. 各カレンダーから最新のイベントをフェッチしてマージ
    for (const cal of calendars) {
      try {
        const response = await calendar.events.list({
          calendarId: cal.id,
          timeMin: timeMin,
          timeMax: timeMax,
          singleEvents: true,
          orderBy: "startTime",
        });

        const googleEvents = response.data.items || [];

        for (const event of googleEvents) {
          const googleEventId = event.id;
          if (!googleEventId) continue;
          if (event.status === "cancelled") continue;

          const title = event.summary || "無題の予定";
          const description = event.description || "";

          const startDateTime = event.start?.dateTime || event.start?.date;
          const endDateTime = event.end?.dateTime || event.end?.date;
          if (!startDateTime) continue;

          const startAtLocal = formatToLocalString(startDateTime);
          const endAtLocal = endDateTime ? formatToLocalString(endDateTime) : null;

          const existingLocal = localMap.get(googleEventId);

          if (existingLocal) {
            // A. 既にローカルに存在する -> 差分があれば更新
            const hasChanges =
              existingLocal.title !== title ||
              existingLocal.start_at !== startAtLocal ||
              existingLocal.end_at !== endAtLocal ||
              existingLocal.description !== description ||
              existingLocal.google_calendar_id !== cal.id;

            if (hasChanges) {
              scheduleRepo.updateScheduleFromGoogle(
                existingLocal.id,
                title,
                startAtLocal,
                endAtLocal,
                description,
                cal.id
              );
              console.log(`✏️ [同期] 予定更新: ${title} (${cal.summary})`);
            }

            // マップから削除して生存マークをつける
            localMap.delete(googleEventId);
          } else {
            // B. ローカルに存在しない -> 新規作成、または未リンクのローカルイベントの紐付け
            const unlinkedLocal = scheduleRepo.getScheduleByTitleAndStart(userId, SYNC_BOT_ID, title, startAtLocal);

            if (unlinkedLocal) {
              scheduleRepo.linkGoogleEventId(unlinkedLocal.id, googleEventId, cal.id);
              console.log(`🔗 [同期] 予定紐付け: ${title} -> ${cal.summary}`);
            } else {
              scheduleRepo.addSchedule(
                userId,
                SYNC_BOT_ID,
                title,
                startAtLocal,
                endAtLocal || undefined,
                undefined,
                description,
                googleEventId,
                cal.id
              );
              console.log(`✨ [同期] 新規登録: ${title} (${cal.summary})`);
            }
          }
        }
      } catch (calError) {
        console.error(`カレンダー ${cal.summary} (${cal.id}) の同期中にエラーが発生しました:`, calError);
      }
    }

    // 3. カレンダー側で削除されたため、マップに残ったローカル予定を削除
    for (const [, localEvent] of localMap.entries()) {
      scheduleRepo.deleteSchedule(localEvent.id, userId, SYNC_BOT_ID);
      console.log(`🗑️ [同期] 削除検知: ${localEvent.title}`);
    }

    console.log("✅ 全Googleカレンダーの同期完了");
  } catch (error) {
    console.error("Googleカレンダーの同期処理全般でエラーが発生しました:", error);
  }
}
