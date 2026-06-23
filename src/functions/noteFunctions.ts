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
			"ユーザーから「〜を覚えておいて」と指示された長期的な属性・背景知識（例:「乳製品アレルギー」「仕事はエンジニア」「締め切りは毎週金曜」）を" +
			"コンテキストノートへ1行追記します。ノートは毎回の会話でシステムプロンプトに注入されるため、本当に長期的な情報のみを保存してください。" +
			"短期的な一時メモは addClipboardEntry、複数ステップの操作手順は savePlaybook を使うこと。" +
			"既存ノートと重複・矛盾する情報に気づいた場合は、ユーザーに確認した上で setContextNote で全体を整理して更新してください（§3.7.3）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description:
						"記憶する短い1行の文章（例: 'ユーザーは乳製品アレルギー'）",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "getContextNote",
		description:
			"コンテキストノートの現在の全文を取得します。ノートの整理・重複確認・「何を覚えてる？」への回答時に呼び出します。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "setContextNote",
		description:
			"コンテキストノートを全文置換します。重複・矛盾の整理や「〇〇を忘れて」への対応時に、整理後の全文を渡してください。" +
			"必ず事前に getContextNote で現在の内容を確認し、置換後の内容をユーザーに提示して承認を得てから呼び出すこと（誤消去防止）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description: `整理後のノート全文（${CONTEXT_NOTE_MAX_LENGTH.toLocaleString()}文字以内。改行区切りの箇条書き推奨）`,
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
