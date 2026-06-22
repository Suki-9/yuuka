import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import * as scheduleRepo from "../db/scheduleRepo.js";
import { formatDateTime } from "../utils/formatters.js";
import { getUserRemindDefaultMinutes } from "../db/userRepo.js";
import {
	isCalendarEnabled,
	createCalendarEvent,
	deleteCalendarEvent,
	syncGoogleCalendarToLocal,
} from "../services/googleCalendarService.js";

// ─── 予定管理 Function（§3.2: Googleカレンダー双方向同期） ────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "addSchedule",
		description:
			"新しい予定・スケジュールを登録する。Googleカレンダー連携が有効な場合は自動的にカレンダーにも同期される。" +
			"カレンダーを汚したくない単発タイマー・リマインダー用途の場合は local_only を true に設定する（単純な「n分後に教えて」は addReminder の方が適切）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				title: { type: SchemaType.STRING, description: "予定のタイトル" },
				start_at: {
					type: SchemaType.STRING,
					description: "開始日時 (ISO 8601形式、例: 2026-05-28T10:00:00)",
				},
				end_at: {
					type: SchemaType.STRING,
					description: "終了日時 (ISO 8601形式、任意)",
				},
				remind_before_minutes: {
					type: SchemaType.NUMBER,
					description:
						"何分前にリマインドするか（省略時はユーザー設定のデフォルト値）",
				},
				description: {
					type: SchemaType.STRING,
					description: "予定の詳細（任意）",
				},
				calendar_id: {
					type: SchemaType.STRING,
					description:
						"登録先GoogleカレンダーのID（任意。目的に最も適したカレンダーIDを選択し設定します）",
				},
				local_only: {
					type: SchemaType.BOOLEAN,
					description:
						"Googleカレンダーに同期せず、ボットのローカル通知のみに留めるか",
				},
			},
			required: ["title", "start_at"],
		},
	},
	{
		name: "listSchedules",
		description:
			"今後の予定一覧を取得する（取得前にGoogleカレンダーとの双方向同期を実行する）",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				days: {
					type: SchemaType.NUMBER,
					description: "何日先までの予定を表示するか (デフォルト7日)",
				},
			},
		},
	},
	{
		name: "deleteSchedule",
		description:
			"予定を削除する（Googleカレンダーに同期済みの場合はカレンダー側からも削除される）",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				schedule_id: {
					type: SchemaType.NUMBER,
					description: "削除する予定のID",
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

		let googleEventId: string | undefined = undefined;
		let googleCalendarId: string | undefined = undefined;

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
