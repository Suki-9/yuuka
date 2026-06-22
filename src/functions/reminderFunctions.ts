import { SchemaType } from "@google/generative-ai";
import type { FunctionDeclaration } from "@google/generative-ai";
import { CronExpressionParser } from "cron-parser";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import * as reminderRepo from "../db/reminderRepo.js";
import {
	parseDbDateTime,
	toDbDateTime,
	type ReminderRecord,
	type ReminderTargetType,
} from "../db/reminderRepo.js";
import { getUserNotifyTarget } from "../db/userRepo.js";

// ─── リマインド Function 群（§3.3） ──────────────────────────────────────────
//
// 時刻指定リマインド・繰り返しリマインドの登録／一覧／キャンセルを提供する。
// 全データは ctx.userId（DiscordユーザーID）でスコープする。
// 実際の送信は services/reminderEngine.ts（毎分cron）が行う（§3.3.2）。

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** Function Call の引数から空でない文字列を取り出す（無ければ undefined） */
function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 送信先タイプ引数の検証（'dm' | 'channel' 以外は undefined） */
function asOptionalTarget(value: unknown): ReminderTargetType | undefined {
	if (value === "dm" || value === "channel") return value;
	return undefined;
}

/** ステータスの表示絵文字 */
function statusEmoji(status: ReminderRecord["status"]): string {
	switch (status) {
		case "pending":
			return "⏳";
		case "sent":
			return "✅";
		default:
			return "🚫";
	}
}

/** ステータスの表示ラベル */
function statusLabel(status: ReminderRecord["status"]): string {
	switch (status) {
		case "pending":
			return "送信待ち";
		case "sent":
			return "送信済み";
		default:
			return "キャンセル済み";
	}
}

/** 日時 'YYYY-MM-DD HH:MM:SS' を表示用 'YYYY-MM-DD HH:MM' に整形する */
function displayDateTime(value: string): string {
	const m = value
		.trim()
		.replace("T", " ")
		.match(/^(\d{4}-\d{2}-\d{2})\s(\d{2}:\d{2})/);
	return m ? `${m[1]} ${m[2]}` : value;
}

/** 送信先の表示ラベル */
function targetLabel(
	reminder: Pick<ReminderRecord, "target_type" | "target_id">,
): string {
	if (reminder.target_type === "channel") {
		return reminder.target_id
			? `チャンネル <#${reminder.target_id}>`
			: "チャンネル（既定送信先）";
	}
	return "DM";
}

/** LLMへ返すリマインドの共通整形 */
function toReminderEntry(reminder: ReminderRecord) {
	return {
		reminder_id: reminder.id,
		message: reminder.message,
		trigger_at: reminder.trigger_at,
		repeat_rule: reminder.repeat_rule,
		target_type: reminder.target_type,
		target_id: reminder.target_id,
		status: reminder.status,
		source: reminder.source,
	};
}

/** 一覧の1行表示（メッセージ用） */
function reminderLine(reminder: ReminderRecord): string {
	const repeat = reminder.repeat_rule
		? ` 🔁 繰り返し(${reminder.repeat_rule})`
		: "";
	return (
		`${statusEmoji(reminder.status)} #${reminder.id} ${displayDateTime(reminder.trigger_at)} ` +
		`「${reminder.message}」→ ${targetLabel(reminder)}${repeat}`
	);
}

// ─── Function Declarations ───────────────────────────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "addReminder",
		description:
			"指定日時にDiscordへ通知を送るリマインドを登録します。「明日の15時に〜を思い出させて」「30分後に教えて」などの依頼で呼び出してください（相対時刻は現在日時を基準にISO 8601へ変換）。「毎週月曜9時に〜」「毎日21時に〜」のような繰り返しリマインドは repeat_rule にcron式（例: 毎週月曜9時 = '0 9 * * 1'、毎日21時 = '0 21 * * *'）を設定し、trigger_at には初回の送信日時を指定してください。単発のリマインドでは repeat_rule を指定してはいけません。送信先はユーザーが明示した場合のみ target を指定します（省略時はユーザー設定の既定送信先）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				message: {
					type: SchemaType.STRING,
					description:
						"リマインドで通知するメッセージ本文（例: '会議の資料を準備する'）",
				},
				trigger_at: {
					type: SchemaType.STRING,
					description:
						"送信日時 (ISO 8601形式: YYYY-MM-DDTHH:MM:SS)。「明日の朝」等の自然言語は現在日時を基準に変換して指定。繰り返しの場合は初回の送信日時",
				},
				repeat_rule: {
					type: SchemaType.STRING,
					description:
						"繰り返しリマインドの場合のみ指定するcron式（分 時 日 月 曜日。例: '0 9 * * 1' = 毎週月曜9時）。単発なら省略（任意）",
				},
				target: {
					type: SchemaType.STRING,
					description:
						"送信先: 'dm'（ダイレクトメッセージ）| 'channel'（チャンネル）。ユーザーが明示した場合のみ指定（任意。省略時はユーザー設定の既定送信先）",
				},
			},
			required: ["message", "trigger_at"],
		},
	},
	{
		name: "listReminders",
		description:
			"登録済みリマインドの一覧を取得します。「リマインド見せて」「設定中の通知は？」などの依頼で呼び出してください。通常は送信待ち（pending）のみ返します。送信済み・キャンセル済みも見たい場合は include_all を true にしてください。キャンセルに必要なIDもこの結果で確認できます。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				include_all: {
					type: SchemaType.BOOLEAN,
					description:
						"送信済み・キャンセル済みのリマインドも含めるか（デフォルト false = 送信待ちのみ）",
				},
			},
		},
	},
	{
		name: "cancelReminder",
		description:
			"登録済みリマインドをキャンセルします。「#3のリマインドやめて」「さっきのリマインド取り消して」などの依頼で呼び出してください。繰り返しリマインドもキャンセルすると以後送信されなくなります。IDが不明な場合は先に listReminders で確認してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				reminder_id: {
					type: SchemaType.NUMBER,
					description: "キャンセルするリマインドのID（#番号）",
				},
			},
			required: ["reminder_id"],
		},
	},
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const handlers: FunctionModule["handlers"] = {
	// リマインド登録（§3.3.1: 時刻指定・繰り返し）
	async addReminder(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const message = asOptionalString(args.message);
		if (!message) {
			return JSON.stringify({
				success: false,
				message: "リマインドのメッセージを指定してください。",
			});
		}

		const triggerAtArg = asOptionalString(args.trigger_at);
		if (!triggerAtArg) {
			return JSON.stringify({
				success: false,
				message: "送信日時 trigger_at (ISO 8601形式) を指定してください。",
			});
		}

		// 日時をDB既存形式 'YYYY-MM-DD HH:MM:SS'（ローカルタイム）へ正規化する
		let triggerAt: string;
		try {
			triggerAt = toDbDateTime(triggerAtArg);
		} catch {
			return JSON.stringify({
				success: false,
				message: `送信日時を解釈できません: ${triggerAtArg}（ISO 8601形式 YYYY-MM-DDTHH:MM:SS で指定してください）`,
			});
		}

		// 繰り返しの場合は cron式の妥当性を登録時に検証する（§3.3.2）
		const repeatRule = asOptionalString(args.repeat_rule);
		if (repeatRule) {
			try {
				CronExpressionParser.parse(repeatRule, { currentDate: new Date() });
			} catch {
				return JSON.stringify({
					success: false,
					message: `repeat_rule のcron式が不正です: ${repeatRule}（例: 毎週月曜9時 = '0 9 * * 1'）`,
				});
			}
		}

		// 過去日時の検査（1分の猶予あり）。繰り返しならcron式から次回時刻へ自動補正する
		if (parseDbDateTime(triggerAt).getTime() < Date.now() - 60_000) {
			if (repeatRule) {
				const next = CronExpressionParser.parse(repeatRule, {
					currentDate: new Date(),
				})
					.next()
					.toDate();
				triggerAt = toDbDateTime(next);
			} else {
				return JSON.stringify({
					success: false,
					message: `送信日時が過去です: ${triggerAtArg}（現在日時: ${toDbDateTime(new Date())}。未来の日時を指定してください）`,
				});
			}
		}

		// 送信先: 明示指定が無ければユーザー設定の既定送信先（users.notify_target_*）に従う（§3.3.2）
		let targetType = asOptionalTarget(args.target);
		let targetId: string | undefined;
		if (!targetType) {
			const pref = getUserNotifyTarget(ctx.userId);
			targetType = pref?.type ?? "dm";
			targetId = pref?.id;
		}

		const reminder = reminderRepo.addReminder(ctx.userId, ctx.botId, {
			message,
			triggerAt,
			repeatRule,
			targetType,
			targetId,
			source: "manual",
		});

		const repeatNote = reminder.repeat_rule
			? `、繰り返し: cron '${reminder.repeat_rule}'（送信後に次回へ自動再設定）`
			: "";
		return JSON.stringify({
			success: true,
			message:
				`リマインドを登録しました⏰ (ID: #${reminder.id})\n` +
				`送信日時: ${displayDateTime(reminder.trigger_at)} → ${targetLabel(reminder)}${repeatNote}`,
			reminder: toReminderEntry(reminder),
		});
	},

	// リマインド一覧（§3.3.1）
	async listReminders(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const includeAll = args.include_all === true;
		const reminders = reminderRepo.listReminders(
			ctx.userId,
			ctx.botId,
			includeAll,
		);
		if (reminders.length === 0) {
			return JSON.stringify({
				success: true,
				message: includeAll
					? "リマインドはありません。"
					: "送信待ちのリマインドはありません。",
				reminders: [],
			});
		}

		const lines = reminders.map(
			(r) =>
				`${reminderLine(r)}${includeAll ? ` [${statusLabel(r.status)}]` : ""}`,
		);
		return JSON.stringify({
			success: true,
			message: `リマインド一覧 (${reminders.length}件${includeAll ? "" : "、送信待ちのみ"}):\n${lines.join("\n")}`,
			reminders: reminders.map(toReminderEntry),
		});
	},

	// リマインドのキャンセル（§3.3.1）
	async cancelReminder(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const reminderId =
			typeof args.reminder_id === "number" ? args.reminder_id : NaN;
		if (!Number.isFinite(reminderId)) {
			return JSON.stringify({
				success: false,
				message: "reminder_id を数値で指定してください。",
			});
		}

		const cancelled = reminderRepo.cancelReminder(
			ctx.userId,
			ctx.botId,
			reminderId,
		);
		if (!cancelled) {
			// 失敗理由を区別して返す（存在しない / 既に送信済み・キャンセル済み）
			const existing = reminderRepo.getReminderById(
				ctx.userId,
				ctx.botId,
				reminderId,
			);
			if (!existing) {
				return JSON.stringify({
					success: false,
					message: `リマインド #${reminderId} が見つかりません。listReminders でIDを確認してください。`,
				});
			}
			return JSON.stringify({
				success: false,
				message: `リマインド #${reminderId} は既に${statusLabel(existing.status)}のためキャンセルできません。`,
			});
		}

		return JSON.stringify({
			success: true,
			message: `リマインド「${cancelled.message}」(#${cancelled.id}) をキャンセルしました🚫`,
			reminder: toReminderEntry(cancelled),
		});
	},
};

// ─── Module Export ───────────────────────────────────────────────────────────

/** リマインド FunctionModule（functions/index.ts でレジストリへマージする） */
export const reminderFunctions: FunctionModule = {
	declarations,
	handlers,
};
