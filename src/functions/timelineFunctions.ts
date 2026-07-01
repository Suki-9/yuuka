import { SchemaType } from "@google/generative-ai";
import type { FunctionDeclaration } from "@google/generative-ai";
import {
	addDayPlanBlock,
	addExpenseRecord,
	addTimelineRecord,
	deleteDayPlanBlock,
	listDayPlanBlocks,
	listTimelineRecords,
	saveMediaFile,
} from "../db/timelineRepo.js";
import { completeTodo } from "../db/todoRepo.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

// ─── デイリータイムライン LLM Function（計画層 + 記録層） ─────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "listDayPlan",
		description:
			"指定日の計画ブロック（交通・タスク・イベント等）と記録（メモ・支出・写真等）を一覧表示する。\n" +
			"今日のスケジュールや予定を確認したいときに使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				date: {
					type: SchemaType.STRING,
					description: "日付 'YYYY-MM-DD'。省略すると今日",
				},
			},
			required: [],
		},
	},
	{
		name: "createDayPlanBlock",
		description:
			"その日のタイムラインに計画ブロックを追加する。\n" +
			"・type='task' : 既存のタスクを時間帯にアサイン（todo_id で紐付け）\n" +
			"・type='transit' : 電車やバスの移動（transit_from / transit_to / transit_line）\n" +
			"・type='event' : 予定・打ち合わせ等\n" +
			"・type='free' : 自由時間・休憩\n" +
			"ルーチンタスクも type='task' でアサインできる。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				date: { type: SchemaType.STRING, description: "日付 'YYYY-MM-DD'" },
				type: {
					type: SchemaType.STRING,
					description: "'task' | 'transit' | 'event' | 'free'",
				},
				title: { type: SchemaType.STRING, description: "ブロックのタイトル" },
				start_time: { type: SchemaType.STRING, description: "開始時刻 'HH:MM'（任意）" },
				end_time: { type: SchemaType.STRING, description: "終了時刻 'HH:MM'（任意）" },
				description: { type: SchemaType.STRING, description: "補足メモ（任意）" },
				todo_id: {
					type: SchemaType.NUMBER,
					description: "type='task' の時、紐付けるタスクID（任意）",
				},
				transit_from: { type: SchemaType.STRING, description: "出発地（type='transit' 時）" },
				transit_to: { type: SchemaType.STRING, description: "到着地（type='transit' 時）" },
				transit_line: { type: SchemaType.STRING, description: "路線・交通機関名（任意）" },
			},
			required: ["date", "type", "title"],
		},
	},
	{
		name: "deleteDayPlanBlock",
		description: "タイムラインの計画ブロックを削除する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				id: { type: SchemaType.NUMBER, description: "削除するブロックのID" },
			},
			required: ["id"],
		},
	},
	{
		name: "addTimelineRecord",
		description:
			"その日の出来事・記録をタイムラインに追加する。\n" +
			"・type='memo' : テキストメモ\n" +
			"・type='expense' : 支出（家計簿にも自動記録される）\n" +
			"・type='task_done' : タスク完了（タスクの状態も同時に完了に変更）\n" +
			"・type='media' : 写真や動画（Discordからの添付ファイルURLを discord_attachment_url で渡す）\n" +
			"・type='location' : 場所・チェックイン\n" +
			"Discordに写真・動画を送ってきた場合は type='media' と discord_attachment_url で記録できる。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				date: { type: SchemaType.STRING, description: "日付 'YYYY-MM-DD'" },
				type: {
					type: SchemaType.STRING,
					description: "'memo' | 'expense' | 'task_done' | 'media' | 'location'",
				},
				title: { type: SchemaType.STRING, description: "見出し（任意）" },
				content: { type: SchemaType.STRING, description: "本文・メモ（任意）" },
				recorded_at: {
					type: SchemaType.STRING,
					description: "記録日時 'YYYY-MM-DD HH:MM:SS'（省略=現在時刻）",
				},
				todo_id: {
					type: SchemaType.NUMBER,
					description: "type='task_done' の時、完了するタスクID",
				},
				amount: {
					type: SchemaType.NUMBER,
					description: "type='expense' の時、金額（円）",
				},
				expense_category: {
					type: SchemaType.STRING,
					description: "type='expense' の時、カテゴリ（食費/交通費/娯楽 等）",
				},
				location: { type: SchemaType.STRING, description: "場所名（任意）" },
				discord_attachment_url: {
					type: SchemaType.STRING,
					description: "type='media' の時、Discordの添付ファイルURL（自動ダウンロード保存）",
				},
				discord_attachment_mime: {
					type: SchemaType.STRING,
					description: "discord_attachment_url 使用時のMIMEタイプ（例: image/jpeg）",
				},
			},
			required: ["date", "type"],
		},
	},
];

const handlers: FunctionModule["handlers"] = {
	async listDayPlan(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const date = typeof args.date === "string" ? args.date : new Date().toISOString().slice(0, 10);
		const blocks = listDayPlanBlocks(ctx.userId, ctx.botId, date);
		const records = listTimelineRecords(ctx.userId, ctx.botId, date);
		if (blocks.length === 0 && records.length === 0) {
			return JSON.stringify({ success: true, message: `${date} の計画・記録はまだありません。`, blocks: [], records: [] });
		}
		return JSON.stringify({ success: true, date, blocks, records });
	},

	async createDayPlanBlock(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const { date, type, title } = args;
		if (typeof date !== "string" || typeof type !== "string" || typeof title !== "string") {
			return JSON.stringify({ success: false, message: "date / type / title は必須です。" });
		}
		const block = addDayPlanBlock(ctx.userId, ctx.botId, {
			date,
			type: type as "task" | "transit" | "event" | "free",
			title,
			description: typeof args.description === "string" ? args.description : undefined,
			startTime: typeof args.start_time === "string" ? args.start_time : undefined,
			endTime: typeof args.end_time === "string" ? args.end_time : undefined,
			todoId: typeof args.todo_id === "number" ? args.todo_id : undefined,
			transitFrom: typeof args.transit_from === "string" ? args.transit_from : undefined,
			transitTo: typeof args.transit_to === "string" ? args.transit_to : undefined,
			transitLine: typeof args.transit_line === "string" ? args.transit_line : undefined,
		});
		return JSON.stringify({ success: true, message: `計画ブロック「${title}」を追加しました。`, block });
	},

	async deleteDayPlanBlock(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const id = Number(args.id);
		if (!id) return JSON.stringify({ success: false, message: "id が必要です。" });
		const ok = deleteDayPlanBlock(ctx.userId, ctx.botId, id);
		return JSON.stringify({ success: ok, message: ok ? "削除しました。" : "ブロックが見つかりません。" });
	},

	async addTimelineRecord(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
		const { date, type } = args;
		if (typeof date !== "string" || typeof type !== "string") {
			return JSON.stringify({ success: false, message: "date / type は必須です。" });
		}

		// 支出
		if (type === "expense") {
			const amount = Number(args.amount);
			if (!amount) return JSON.stringify({ success: false, message: "expense には amount が必要です。" });
			const record = await addExpenseRecord(ctx.userId, ctx.botId, {
				date,
				recordedAt: typeof args.recorded_at === "string" ? args.recorded_at : undefined,
				amount,
				category: typeof args.expense_category === "string" ? args.expense_category : "その他",
				title: typeof args.title === "string" ? args.title : undefined,
				location: typeof args.location === "string" ? args.location : undefined,
			});
			return JSON.stringify({ success: true, message: `¥${amount} を記録しました。`, record });
		}

		// タスク完了
		if (type === "task_done" && typeof args.todo_id === "number") {
			completeTodo(ctx.userId, ctx.botId, args.todo_id);
		}

		// メディア（Discord添付）
		let mediaPath: string | undefined;
		let mediaType: "photo" | "video" | undefined;
		if (type === "media" && typeof args.discord_attachment_url === "string") {
			const mime = typeof args.discord_attachment_mime === "string"
				? args.discord_attachment_mime
				: "image/jpeg";
			try {
				mediaPath = await saveMediaFile({ url: args.discord_attachment_url, mimeType: mime, date });
				mediaType = mime.startsWith("video/") ? "video" : "photo";
			} catch (e) {
				return JSON.stringify({ success: false, message: `メディアの保存に失敗しました: ${(e as Error).message}` });
			}
		}

		const record = addTimelineRecord(ctx.userId, ctx.botId, {
			date,
			recordedAt: typeof args.recorded_at === "string" ? args.recorded_at : undefined,
			type: type as "memo" | "expense" | "task_done" | "media" | "location",
			title: typeof args.title === "string" ? args.title : undefined,
			content: typeof args.content === "string" ? args.content : undefined,
			todoId: typeof args.todo_id === "number" ? args.todo_id : undefined,
			location: typeof args.location === "string" ? args.location : undefined,
			mediaPath,
			mediaType,
		});
		return JSON.stringify({ success: true, message: "記録しました。", record });
	},
};

export const timelineFunctions: FunctionModule = { declarations, handlers };
