import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import {
	appendContextNote,
	CONTEXT_NOTE_MAX_LENGTH,
	getContextNote,
	setContextNote,
} from "../db/contextNoteRepo.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

// ─── コンテキストノート Function（§3.7） ─────────────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "appendContextNote",
		description:
			"ユーザーが「ずっと覚えておいて」と頼んだ、長く変わらない情報をメモ帳に1行書き足す。\n" +
			"・会話のたび自動で読み込まれる大切な情報だけを保存する（例:「乳製品アレルギー」「仕事はエンジニア」「締切は毎週金曜」）。\n" +
			"・今日だけの一時メモ → 代わりに addClipboardEntry を使う。\n" +
			"・操作の手順（複数ステップ）→ 代わりに savePlaybook を使う。\n" +
			"・同じ内容や食い違う内容が既にある時は、ユーザーに確認してから setContextNote で全文を整理し直す。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description:
						"覚えておく短い1行の文章（例: 'ユーザーは乳製品アレルギー'）",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "getContextNote",
		description:
			"今メモ帳に書いてある内容を全部読み出す。\n" +
			"・「何を覚えてる？」に答える時や、整理・重複チェックの前に今の中身を確認したい時に使う。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "setContextNote",
		description:
			"メモ帳の中身を、渡した全文でまるごと書き換える（古い内容は消える）。\n" +
			"・「〇〇を忘れて」や、重複・矛盾を整理したい時に使う。\n" +
			"・誤って消さないため、先に getContextNote で今の中身を読み、書き換え後の全文をユーザーに見せて承認を得てから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description: `書き換え後のメモ帳の全文（${CONTEXT_NOTE_MAX_LENGTH.toLocaleString()}文字まで。改行で区切った箇条書きがおすすめ）`,
				},
			},
			required: ["content"],
		},
	},
];

const handlers: FunctionModule["handlers"] = {
	appendContextNote(ctx: ToolContext, args: Record<string, unknown>): string {
		const content = String(args.content ?? "").trim();
		if (!content) {
			return JSON.stringify({
				success: false,
				message: "記憶する内容が空です。",
			});
		}
		try {
			const full = appendContextNote(ctx.userId, ctx.botId, content);
			return JSON.stringify({
				success: true,
				message: "コンテキストノートに追記しました📝",
				total_length: full.length,
				max_length: CONTEXT_NOTE_MAX_LENGTH,
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: (err as Error).message,
			});
		}
	},

	getContextNote(ctx: ToolContext): string {
		const note = getContextNote(ctx.userId, ctx.botId);
		return JSON.stringify({
			success: true,
			content: note,
			length: note.length,
			max_length: CONTEXT_NOTE_MAX_LENGTH,
		});
	},

	setContextNote(ctx: ToolContext, args: Record<string, unknown>): string {
		const content = String(args.content ?? "");
		try {
			setContextNote(ctx.userId, ctx.botId, content);
			return JSON.stringify({
				success: true,
				message: "コンテキストノートを更新しました📝",
				total_length: content.length,
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: (err as Error).message,
			});
		}
	},
};

/** コンテキストノート FunctionModule */
export const noteFunctions: FunctionModule = {
	declarations,
	handlers,
};
