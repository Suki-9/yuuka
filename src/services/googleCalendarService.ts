import { type Auth, google } from "googleapis";
import { config } from "../config.js";
import {
	getAccountForBot,
	getPrimaryGoogleAccount,
	parseAccountCalendars,
	type UserGoogleAccount,
} from "../db/googleAccountRepo.js";
import * as scheduleRepo from "../db/scheduleRepo.js";
import { decryptText } from "../utils/crypto.js";

// ─── Google Calendar 連携 ───────────────────────────────────────────────────
// v5: OAuth情報は user_google_accounts（owner単位・複数可）から取得する。
// 解決順: botId 指定時は bot_google_account の割当 → 無ければ owner primary、未指定時は owner primary。
// Client ID / Secret はシステム共通設定（config.googleClientId/Secret）。

/** 文脈(userId, botId?)から使用する Google アカウントを解決する。 */
function resolveAccount(
	userId: string,
	botId?: string,
): UserGoogleAccount | undefined {
	return botId
		? getAccountForBot(botId, userId)
		: getPrimaryGoogleAccount(userId);
}

/** カレンダーの要約（UI表示・キャッシュ共通の形）。 */
type CalendarSummary = { id: string; summary: string };

/** 対象カレンダーIDの解決規則: 明示 calendarId → アカウントの calendar_id → ""（未指定）。 */
function resolveTargetCalendarId(
	acct: UserGoogleAccount | undefined,
	explicit?: string,
): string {
	return explicit || acct?.calendar_id || "";
}

/** OAuth2 認証から Calendar v3 クライアントを生成する（version 文字列の集約点）。 */
function calendarClient(auth: Auth.OAuth2Client) {
	return google.calendar({ version: "v3", auth });
}

function decryptAccountRefreshToken(acct: UserGoogleAccount): string | null {
	try {
		return decryptText(
			acct.refresh_token_encrypted,
			acct.refresh_token_iv,
			acct.refresh_token_tag,
		);
	} catch (err) {
		console.error(
			`Googleアカウント #${acct.id} のリフレッシュトークン復号に失敗しました:`,
			err,
		);
		return null;
	}
}

function oauthClientFromAccount(
	acct: UserGoogleAccount | undefined,
): Auth.OAuth2Client | null {
	if (!acct) return null;
	const refreshToken = decryptAccountRefreshToken(acct);
	if (!config.googleClientId || !config.googleClientSecret || !refreshToken)
		return null;
	try {
		const auth = new google.auth.OAuth2(
			config.googleClientId,
			config.googleClientSecret,
		);
		auth.setCredentials({ refresh_token: refreshToken });
		return auth;
	} catch (error) {
		console.error(
			"Google OAuth2 認証クライアントの初期化に失敗しました:",
			error,
		);
		return null;
	}
}

/**
 * ユーザー/Bot 文脈の Google OAuth2 認証クライアント（Calendar / Drive 共用）。
 * botId 未指定時は owner の primary アカウント（バックアップ・秘書フォールバック等）。
 */
export function getOAuthClientForUser(
	userId: string,
	botId?: string,
): Auth.OAuth2Client | null {
	return oauthClientFromAccount(resolveAccount(userId, botId));
}

function getCalendarClient(userId: string, botId?: string) {
	const auth = getOAuthClientForUser(userId, botId);
	if (!auth) return null;
	return calendarClient(auth);
}

/** Googleカレンダー連携が有効か（文脈の解決アカウントが存在し復号可能か）。 */
export function isCalendarEnabled(userId: string, botId?: string): boolean {
	return getCalendarClient(userId, botId) !== null;
}

/** アカウント単位で利用可能なカレンダー一覧を取得する。 */
export async function fetchCalendarsForAccount(
	acct: UserGoogleAccount,
): Promise<CalendarSummary[]> {
	const auth = oauthClientFromAccount(acct);
	if (!auth) return [];
	const calendar = calendarClient(auth);
	const selectedCalendarIds = parseAccountCalendars(acct);
	const defaultCalendarId = acct.calendar_id;

	// 1. 同期対象カレンダーが指定されている場合はそちらを最優先
	if (selectedCalendarIds.length > 0) {
		const list: CalendarSummary[] = [];
		for (const id of selectedCalendarIds) {
			try {
				const response = await calendar.calendars.get({ calendarId: id });
				if (response.data.summary)
					list.push({ id, summary: response.data.summary });
			} catch (err) {
				console.error(`カレンダー情報取得失敗 (${id}):`, err);
				list.push({
					id,
					summary:
						id === defaultCalendarId
							? "メインカレンダー"
							: `カレンダー (${id})`,
				});
			}
		}
		return list;
	}

	// 2. 指定がない場合は calendarList.list をフォールバック
	try {
		const response = await calendar.calendarList.list({
			minAccessRole: "writer",
		});
		const list = (response.data.items || [])
			.filter((item) => item.id && item.summary)
			.map((item) => ({ id: item.id!, summary: item.summary! }));
		if (
			defaultCalendarId &&
			!list.some((item) => item.id === defaultCalendarId)
		) {
			try {
				const primaryRes = await calendar.calendars.get({
					calendarId: defaultCalendarId,
				});
				list.unshift({
					id: defaultCalendarId,
					summary: primaryRes.data.summary || "デフォルトカレンダー",
				});
			} catch {
				list.unshift({
					id: defaultCalendarId,
					summary: "デフォルトカレンダー",
				});
			}
		}
		return list;
	} catch (error) {
		console.error("カレンダー一覧の取得に失敗しました:", error);
		if (defaultCalendarId)
			return [{ id: defaultCalendarId, summary: "デフォルトカレンダー" }];
		return [];
	}
}

// アカウント別キャッシュ（accountId キー）
const cachedCalendarsMap = new Map<
	number,
	{ calendars: CalendarSummary[]; lastFetched: number }
>();
const CACHE_TTL = 5 * 60 * 1000; // 5分キャッシュ
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const calendarCacheSweep = setInterval(
	() => {
		const now = Date.now();
		for (const [accountId, entry] of cachedCalendarsMap) {
			if (now - entry.lastFetched >= CACHE_TTL)
				cachedCalendarsMap.delete(accountId);
		}
	},
	30 * 60 * 1000,
);
calendarCacheSweep.unref();

/** ユーザー/Bot 文脈のキャッシュ付きカレンダー一覧。 */
export async function getCachedCalendars(
	userId: string,
	botId?: string,
): Promise<CalendarSummary[]> {
	const acct = resolveAccount(userId, botId);
	if (!acct) return [];
	const now = Date.now();
	const cached = cachedCalendarsMap.get(acct.id);
	if (
		cached &&
		cached.calendars.length > 0 &&
		now - cached.lastFetched < CACHE_TTL
	) {
		return cached.calendars;
	}
	const calendars = await fetchCalendarsForAccount(acct);
	cachedCalendarsMap.set(acct.id, { calendars, lastFetched: now });
	return calendars;
}

/** アカウント単位でキャッシュ無効化（同期対象変更・再連携時）。 */
export function invalidateCalendarCacheForAccount(accountId: number): void {
	cachedCalendarsMap.delete(accountId);
}

/** ユーザー/Bot 文脈でキャッシュ無効化（解決アカウントの分）。 */
export function invalidateCalendarCache(userId: string, botId?: string): void {
	const acct = resolveAccount(userId, botId);
	if (acct) cachedCalendarsMap.delete(acct.id);
}

/** ユーザー/Bot 文脈で解決されるアカウントのデフォルトカレンダーID（未連携時は ""）。 */
export function getResolvedCalendarId(userId: string, botId?: string): string {
	return resolveTargetCalendarId(resolveAccount(userId, botId));
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
	calendarId?: string,
	botId?: string,
): Promise<{ eventId: string; calendarId: string } | null> {
	const calendar = getCalendarClient(userId, botId);
	if (!calendar) return null;

	const acct = resolveAccount(userId, botId);
	if (!acct) return null;

	try {
		const isoStart = formatToISOString(startAt);
		// 終了時刻がない場合は開始から1時間後を設定
		const isoEnd = endAt
			? formatToISOString(endAt)
			: new Date(new Date(isoStart).getTime() + HOUR_MS).toISOString();

		const targetCalendarId = resolveTargetCalendarId(acct, calendarId);

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
export async function deleteCalendarEvent(
	userId: string,
	eventId: string,
	calendarId?: string,
	botId?: string,
): Promise<boolean> {
	const calendar = getCalendarClient(userId, botId);
	if (!calendar) return false;

	const acct = resolveAccount(userId, botId);

	try {
		const targetCalendarId = resolveTargetCalendarId(acct, calendarId);
		await calendar.events.delete({
			calendarId: targetCalendarId,
			eventId: eventId,
		});
		return true;
	} catch (error: any) {
		if (error.status === 404) {
			return true;
		}
		console.error(
			`Googleカレンダーのイベント削除に失敗しました (EventID: ${eventId}, CalendarID: ${calendarId}):`,
			error,
		);
		return false;
	}
}

/**
 * すべての利用可能カレンダーとローカルDBの双方向同期を実行する
 */
export async function syncGoogleCalendarToLocal(
	userId: string,
	daysWindow: number = 30,
): Promise<void> {
	const calendar = getCalendarClient(userId);
	if (!calendar) return;

	try {
		const calendars = await getCachedCalendars(userId);
		console.log(
			`🔄 Googleカレンダー同期中... (対象ユーザー: ${userId}, カレンダー数: ${calendars.length})`,
		);

		const now = new Date();
		// 1日前から同期ウィンドウの終わりまでを取得
		const timeMin = new Date(now.getTime() - DAY_MS).toISOString();
		const timeMax = new Date(now.getTime() + daysWindow * DAY_MS).toISOString();

		// Googleカレンダー連携はユーザー全体の統合機能のため、同期される予定は
		// デフォルト秘書（system_default）に帰属させる（秘書業務データのBot別分離 §v3）。
		const SYNC_BOT_ID = "system_default";

		// 1. ローカルの該当期間内の「Google同期済み予定」をマップとして取得
		const localSchedules = scheduleRepo.listAllFutureSchedulesWithGoogleId(
			userId,
			SYNC_BOT_ID,
		);
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
					const endAtLocal = endDateTime
						? formatToLocalString(endDateTime)
						: null;

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
								cal.id,
							);
							console.log(`✏️ [同期] 予定更新: ${title} (${cal.summary})`);
						}

						// マップから削除して生存マークをつける
						localMap.delete(googleEventId);
					} else {
						// B. ローカルに存在しない -> 新規作成、または未リンクのローカルイベントの紐付け
						const unlinkedLocal = scheduleRepo.getScheduleByTitleAndStart(
							userId,
							SYNC_BOT_ID,
							title,
							startAtLocal,
						);

						if (unlinkedLocal) {
							scheduleRepo.linkGoogleEventId(
								unlinkedLocal.id,
								googleEventId,
								cal.id,
							);
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
								cal.id,
							);
							console.log(`✨ [同期] 新規登録: ${title} (${cal.summary})`);
						}
					}
				}
			} catch (calError) {
				console.error(
					`カレンダー ${cal.summary} (${cal.id}) の同期中にエラーが発生しました:`,
					calError,
				);
			}
		}

		// 3. カレンダー側で削除されたため、マップに残ったローカル予定を削除
		for (const [, localEvent] of localMap.entries()) {
			scheduleRepo.deleteSchedule(localEvent.id, userId, SYNC_BOT_ID);
			console.log(`🗑️ [同期] 削除検知: ${localEvent.title}`);
		}

		console.log("✅ 全Googleカレンダーの同期完了");
	} catch (error) {
		console.error(
			"Googleカレンダーの同期処理全般でエラーが発生しました:",
			error,
		);
	}
}
