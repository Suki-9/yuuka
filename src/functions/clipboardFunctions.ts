import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { addEntry, deleteEntry, listEntries } from "../db/clipboardRepo.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { toDbDateTime } from "../utils/datetime.js";

// ─── クリップボード / 一時メモ Function（§3.10） ─────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "addClipboardEntry",
		description:
			"「今日だけ」の一時メモをクリップボードに保存する。期限が来ると自動で消える（既定24時間）。\n" +
			"・例:「今日の会議メモ」「あとで調べるURL」「買い物リスト」。\n" +
			"・ずっと使う情報（プロフィールや好みなど）→ 代わりに appendContextNote を使う。\n" +
			"・常時は読み込まれないので、ユーザーが見たがったら listClipboardEntries を呼ぶ。\n" +
			"・「今週中だけ」→ ttl_hours:168、「1時間後に消して」→ ttl_hours:1 のように変換する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: { type: SchemaType.STRING, description: "メモする内容" },
				ttl_hours: {
					type: SchemaType.NUMBER,
					description:
						"何時間で自動削除するか（時間単位）。省略=24時間。0=ずっと消えない",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "listClipboardEntries",
		description:
			"クリップボード（一時メモ）の今も有効なメモを一覧で取り出す。\n" +
			"・例:「メモを見せて」「さっきクリップした内容は？」と言われた時に呼ぶ。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "deleteClipboardEntry",
		description:
			"クリップボードの指定したメモを1件削除する。\n" +
			"・例:「〇〇のメモを消して」と言われた時に使う。\n" +
			"・消し間違えないよう、先に listClipboardEntries で正しいIDを確かめてから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				entry_id: {
					type: SchemaType.NUMBER,
					description: "削除するメモのID（listClipboardEntries で確認した番号）",
				},
			},
			required: ["entry_id"],
		},
	},
];

const handlers: FunctionModule["handlers"] = {
	addClipboardEntry(ctx: ToolContext, args: Record<string, unknown>): string {
		const content = String(args.content ?? "").trim();
		if (!content) {
			return JSON.stringify({
				success: false,
				message: "メモの内容が空です。",
			});
		}

		const ttlHoursRaw =
			args.ttl_hours === undefined ? 24 : Number(args.ttl_hours);
		if (!Number.isFinite(ttlHoursRaw) || ttlHoursRaw < 0) {
			return JSON.stringify({
				success: false,
				message: "ttl_hours は0以上の数値で指定してください。",
			});
		}

		// 0 = 無期限（§3.10.4: expires_at NULL）
		const expiresAt =
			ttlHoursRaw === 0
				? null
				: toDbDateTime(new Date(Date.now() + ttlHoursRaw * 60 * 60 * 1000));

		const entry = addEntry(ctx.userId, ctx.botId, content, expiresAt);
		return JSON.stringify({
			success: true,
			message:
				ttlHoursRaw === 0
					? "クリップボードに保存しました（無期限）📎"
					: `クリップボードに保存しました（${ttlHoursRaw}時間後に自動削除）📎`,
			entry: {
				id: entry.id,
				content: entry.content,
				expires_at: entry.expires_at,
			},
		});
	},

	listClipboardEntries(ctx: ToolContext): string {
		const entries = listEntries(ctx.userId, ctx.botId);
		return JSON.stringify({
			success: true,
			count: entries.length,
			entries: entries.map((e) => ({
				id: e.id,
				content: e.content,
				expires_at: e.expires_at ?? "無期限",
				created_at: e.created_at,
			})),
		});
	},

	deleteClipboardEntry(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): string {
		const id = Number(args.entry_id);
		if (!Number.isInteger(id)) {
			return JSON.stringify({
				success: false,
				message: "entry_id が不正です。",
			});
		}
		const ok = deleteEntry(ctx.userId, ctx.botId, id);
		return JSON.stringify({
			success: ok,
			message: ok
				? "メモを削除しました🗑️"
				: "指定されたメモが見つかりませんでした。",
		});
	},
};

/** クリップボード FunctionModule */
export const clipboardFunctions: FunctionModule = {
	declarations,
	handlers,
};
