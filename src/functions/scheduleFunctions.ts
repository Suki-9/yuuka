import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import * as scheduleRepo from "../db/scheduleRepo.js";
import { getUserRemindDefaultMinutes } from "../db/userRepo.js";
import {
	createCalendarEvent,
	deleteCalendarEvent,
	isCalendarEnabled,
	syncGoogleCalendarToLocal,
} from "../services/googleCalendarService.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { formatDateTime } from "../utils/formatters.js";

// ─── 予定管理 Function（§3.2: Googleカレンダー双方向同期） ────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "addSchedule",
		description:
			"日時の決まった予定をカレンダーに登録する。\n" +
			"・例:「来週月曜10時に打ち合わせ」「5/28に歯医者」。\n" +
			"・Googleカレンダー連携が入っていると、自動でそちらにも同じ予定が追加される。\n" +
			"・カレンダーを汚したくない単発のタイマーやリマインダーなら local_only を true にする。\n" +
			"・ただ「n分後に教えて」だけなら → 代わりに addReminder を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				title: { type: SchemaType.STRING, description: "予定の名前（例:「歯医者」「定例会議」）" },
				start_at: {
					type: SchemaType.STRING,
					description: "開始する日時。形式: ISO 8601（例: 2026-05-28T10:00:00）",
				},
				end_at: {
					type: SchemaType.STRING,
					description: "終了する日時。形式: ISO 8601。省略可",
				},
				remind_before_minutes: {
					type: SchemaType.NUMBER,
					description:
						"開始の何分前に知らせるか（分単位）。省略=ユーザー設定の既定値",
				},
				description: {
					type: SchemaType.STRING,
					description: "予定の補足メモ。省略可",
				},
				calendar_id: {
					type: SchemaType.STRING,
					description:
						"登録先のGoogleカレンダーのID。省略可。複数ある時は内容に一番合うものを選ぶ",
				},
				local_only: {
					type: SchemaType.BOOLEAN,
					description:
						"true にするとGoogleカレンダーに送らず、ボット内の通知だけにする",
				},
			},
			required: ["title", "start_at"],
		},
	},
	{
		name: "listSchedules",
		description:
			"これから先の予定の一覧を表示する。\n" +
			"・例:「今週の予定は?」「直近の予定を見せて」。\n" +
			"・表示する前にGoogleカレンダーと最新状態をやり取りして同期する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				days: {
					type: SchemaType.NUMBER,
					description: "今日から何日先までの予定を表示するか（日数）。省略=7日",
				},
			},
		},
	},
	{
		name: "deleteSchedule",
		description:
			"指定したIDの予定を削除する。\n" +
			"・例:「#3の予定を消して」。どの予定か分からない時は先に listSchedules でIDを確認する。\n" +
			"・Googleカレンダーに同期済みなら、向こうの予定も一緒に消える。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				schedule_id: {
					type: SchemaType.NUMBER,
					description: "削除する予定のID（listSchedules で表示される番号）",
				},
			},
			required: ["schedule_id"],
		},
	},
];

const handlers: FunctionModule["handlers"] = {
	async addSchedule(
		ctx: ToolContext,
		rawArgs: Record<string, unknown>,
	): Promise<string> {
		const args = rawArgs as {
			title: string;
			start_at: string;
			end_at?: string;
			remind_before_minutes?: number;
			description?: string;
			calendar_id?: string;
			local_only?: boolean;
		};
		const userId = ctx.userId;

		if (!args.title || !args.start_at) {
			return JSON.stringify({
				success: false,
				message: "title と start_at は必須です。",
			});
		}

		let googleEventId: string | undefined;
		let googleCalendarId: string | undefined;

		if (isCalendarEnabled(userId, ctx.botId) && !args.local_only) {
			try {
				const eventResult = await createCalendarEvent(
					userId,
					args.title,
					args.start_at,
					args.end_at,
					args.description,
					args.calendar_id,
					ctx.botId,
				);
				if (eventResult) {
					googleEventId = eventResult.eventId;
					googleCalendarId = eventResult.calendarId;
				}
			} catch (err) {
				console.error("予定追加時のGoogleカレンダー同期に失敗しました:", err);
			}
		}

		// 通知前時間のデフォルトはユーザー設定に従う（§3.3.2）
		const remindBefore =
			args.remind_before_minutes !== undefined
				? Number(args.remind_before_minutes)
				: getUserRemindDefaultMinutes(userId);

		const schedule = scheduleRepo.addSchedule(
			userId,
			ctx.botId,
			args.title,
			args.start_at,
			args.end_at,
			remindBefore,
			args.description,
			googleEventId,
			googleCalendarId,
		);

		const remindLabel =
			schedule.remind_before_minutes > 0
				? `、${schedule.remind_before_minutes}分前にリマインド`
				: "";

		const syncMessage = googleEventId
			? "（Googleカレンダーにも同期しました📅）"
			: isCalendarEnabled(userId, ctx.botId)
				? "（ローカルリマインダーとして登録しました🔔）"
				: "";

		return JSON.stringify({
			success: true,
			message: `予定「${schedule.title}」を登録しました (${formatDateTime(schedule.start_at)}${remindLabel})${syncMessage}`,
			schedule,
		});
	},

	async listSchedules(
		ctx: ToolContext,
		rawArgs: Record<string, unknown>,
	): Promise<string> {
		const userId = ctx.userId;
		const days = rawArgs.days !== undefined ? Number(rawArgs.days) : 7;

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

		const schedules = scheduleRepo.listUpcomingSchedules(
			userId,
			ctx.botId,
			days,
		);
		if (schedules.length === 0) {
			return JSON.stringify({
				success: true,
				message: `今後${days}日間の予定はありません。`,
				schedules: [],
			});
		}

		const lines = schedules.map((s) => {
			const googleIcon = s.google_event_id ? "📅" : "📌";
			return `${googleIcon} #${s.id} ${s.title} — ${formatDateTime(s.start_at)}`;
		});

		return JSON.stringify({
			success: true,
			message: `今後${days}日間の予定 (${schedules.length}件):\n${lines.join("\n")}`,
			schedules,
		});
	},

	async deleteSchedule(
		ctx: ToolContext,
		rawArgs: Record<string, unknown>,
	): Promise<string> {
		const userId = ctx.userId;
		const scheduleId = Number(rawArgs.schedule_id);
		if (!Number.isInteger(scheduleId)) {
			return JSON.stringify({
				success: false,
				message: "schedule_id が不正です。",
			});
		}

		const schedule = scheduleRepo.getScheduleById(scheduleId);
		if (!schedule || schedule.user_id !== userId) {
			return JSON.stringify({
				success: false,
				message: `予定 #${scheduleId} が見つかりません。`,
			});
		}

		// Googleカレンダーからも削除
		if (isCalendarEnabled(userId, ctx.botId) && schedule.google_event_id) {
			try {
				await deleteCalendarEvent(
					userId,
					schedule.google_event_id,
					schedule.google_calendar_id || undefined,
					ctx.botId,
				);
			} catch (err) {
				console.error(
					`予定削除時のGoogleカレンダー同期に失敗しました (EventID: ${schedule.google_event_id}):`,
					err,
				);
			}
		}

		const deleted = scheduleRepo.deleteSchedule(scheduleId, userId, ctx.botId);
		if (!deleted) {
			return JSON.stringify({
				success: false,
				message: `予定 #${scheduleId} の削除に失敗しました。`,
			});
		}

		return JSON.stringify({
			success: true,
			message: `予定 #${scheduleId} を削除しました🗑️`,
		});
	},
};

/** 予定管理 FunctionModule */
export const scheduleFunctions: FunctionModule = {
	declarations,
	handlers,
};
