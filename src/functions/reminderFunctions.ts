import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { CronExpressionParser } from "cron-parser";
import * as reminderRepo from "../db/reminderRepo.js";
import {
	parseDbDateTime,
	type ReminderRecord,
	type ReminderTargetType,
	toDbDateTime,
} from "../db/reminderRepo.js";
import { getUserNotifyTarget } from "../db/userRepo.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

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
			"決めた日時にDiscordへお知らせを送るリマインドを登録する。\n" +
				"・例:「明日の15時に〜を思い出させて」「30分後に教えて」。「30分後」などは今の時刻を基準に日時へ直す。\n" +
				"・毎週・毎日など繰り返したい時は repeat_rule にcron式を入れ（例: 毎週月曜9時='0 9 * * 1'、毎日21時='0 21 * * *'）、trigger_at には1回目の日時を入れる。\n" +
				"・1回だけのリマインドでは repeat_rule を入れない。\n" +
				"・送り先 target はユーザーがはっきり指定した時だけ入れる。省略するとユーザー設定の既定の送り先に届く。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				message: {
					type: SchemaType.STRING,
					description:
						"お知らせで届ける本文（例: '会議の資料を準備する'）。",
				},
				trigger_at: {
					type: SchemaType.STRING,
					description:
						"送る日時。形式: YYYY-MM-DDTHH:MM:SS（例 2026-06-27T09:00:00）。「明日の朝」などの言葉は今の時刻を基準に日時へ直して入れる。繰り返しの時は1回目の日時。",
				},
				repeat_rule: {
					type: SchemaType.STRING,
					description:
						"繰り返す時だけ入れるcron式（並びは 分 時 日 月 曜日。例 '0 9 * * 1' = 毎週月曜9時）。1回だけなら省略する。",
				},
				target: {
					type: SchemaType.STRING,
					description:
						"送り先。'dm'＝ダイレクトメッセージ、'channel'＝チャンネル。ユーザーがはっきり指定した時だけ入れる。省略するとユーザー設定の既定の送り先になる。",
				},
			},
			required: ["message", "trigger_at"],
		},
	},
	{
		name: "listReminders",
		description:
			"登録してあるリマインドの一覧を見せる。\n" +
				"・例:「リマインド見せて」「設定中の通知は？」。\n" +
				"・ふだんは送信待ちのものだけ返す。送信済み・キャンセル済みも見たい時は include_all を true にする。\n" +
				"・キャンセルに使うIDもこの一覧で分かる。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				include_all: {
					type: SchemaType.BOOLEAN,
					description:
						"送信済み・キャンセル済みのリマインドも一覧に含めるか。省略=false=送信待ちのものだけ。",
				},
			},
		},
	},
	{
		name: "cancelReminder",
		description:
			"登録してあるリマインドを取り消す。\n" +
				"・例:「#3のリマインドやめて」「さっきのリマインド取り消して」。\n" +
				"・繰り返しのリマインドも取り消すと、それ以降は送られなくなる。\n" +
				"・IDが分からない時は、先に listReminders で確認してから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				reminder_id: {
					type: SchemaType.NUMBER,
					description: "取り消すリマインドのID（#のあとの番号）。",
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
