import { SchemaType } from "@google/generative-ai";
import type { FunctionDeclaration } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { searchMessages, type MessageLogRecord } from "../db/messageLogRepo.js";

// ─── 会話ログ検索・要約 Function 群（§3.12） ─────────────────────────────────
//
// SQLiteに永続保存された全会話履歴（§7）を対象に、LLMが自然言語クエリ
// （「先週の〇〇の話を教えて」等）をキーワード・期間に構造化して検索する。
// プライバシー配慮（§3.12.3）: 検索対象は ctx.userId（本人）の会話のみ。

/** 本文を最大文字数で切り詰める（超過時は末尾に省略記号を付与） */
function truncateContent(content: string, maxLength: number): string {
	const chars = Array.from(content);
	if (chars.length <= maxLength) return content;
	return `${chars.slice(0, maxLength).join("")}…`;
}

/** Function Call の引数から空でない文字列を取り出す（無ければ undefined） */
function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** 検索結果をLLMへ返すための共通整形 */
function toResultEntry(record: MessageLogRecord, maxContentLength: number) {
	return {
		role: record.role,
		created_at: record.created_at,
		content: truncateContent(record.content, maxContentLength),
	};
}

// ─── Function Declarations ───────────────────────────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "searchConversationLogs",
		description:
			"過去の会話履歴（ユーザーとあなたの全てのやり取り）をキーワードや期間で全文検索します。「先週の〇〇の話どうだったっけ」「前に教えてもらったレシピを探して」など、過去の会話内容を思い出す必要がある場合に呼び出してください。「先週」「今月」などの自然言語の期間は、あなたが現在日時を基準に from / to のISO日付（YYYY-MM-DD）へ変換して指定します。キーワードと期間はどちらか一方だけでも検索できます（キーワード省略時は期間のみで検索）。結果は新しい順で、各メッセージ本文は200文字までに切り詰められます。見つかった過去の会話は現在の返答のコンテキストとして活用してください。検索対象は本人の会話のみです。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				keyword: {
					type: SchemaType.STRING,
					description:
						"検索キーワード（例: 'ラーメン', '旅行 計画'）。省略すると期間のみで検索します。",
				},
				from: {
					type: SchemaType.STRING,
					description:
						"検索期間の開始日 (YYYY-MM-DD形式。例: 先週なら先週月曜の日付)（任意）",
				},
				to: {
					type: SchemaType.STRING,
					description:
						"検索期間の終了日 (YYYY-MM-DD形式。その日の終わりまで含む)（任意）",
				},
				limit: {
					type: SchemaType.NUMBER,
					description: "最大取得件数 (デフォルト10件、最大50件)",
				},
			},
		},
	},
	{
		name: "summarizeConversationTopic",
		description:
			"特定の話題に関する過去の会話を期間・キーワードで検索し、要約のための会話ログ（時系列順）を取得します。「先週の旅行計画の話をまとめて」「〇〇について前に何を話したか要約して」のように過去のやり取りの要約を求められた際に呼び出してください。検索結果が多い場合は新しい順の上位10件に絞って返されます。このFunctionは要約そのものは行わないため、返された会話ログを読み、あなたがユーザーの依頼に沿って内容を要約して提示してください。検索対象は本人の会話のみです。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				keyword: {
					type: SchemaType.STRING,
					description:
						"要約したい話題のキーワード（例: '旅行', '引っ越し'）。省略すると期間のみで検索します。",
				},
				from: {
					type: SchemaType.STRING,
					description: "検索期間の開始日 (YYYY-MM-DD形式)（任意）",
				},
				to: {
					type: SchemaType.STRING,
					description:
						"検索期間の終了日 (YYYY-MM-DD形式。その日の終わりまで含む)（任意）",
				},
			},
		},
	},
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const handlers: FunctionModule["handlers"] = {
	// 過去会話のキーワード・期間検索（§3.12.2: キーワード検索 / 期間指定検索 / コンテキスト注入）
	async searchConversationLogs(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const keyword = asOptionalString(args.keyword);
		const from = asOptionalString(args.from);
		const to = asOptionalString(args.to);

		let limit =
			typeof args.limit === "number" && Number.isFinite(args.limit)
				? Math.floor(args.limit)
				: 10;
		limit = Math.min(Math.max(limit, 1), 50);

		// プライバシー（§3.12.3）: ctx.userId を必須条件として本人の会話のみ検索する
		const records = searchMessages(ctx.userId, ctx.botId, {
			keyword,
			from,
			to,
			limit,
		});

		if (records.length === 0) {
			return JSON.stringify({
				success: true,
				message:
					"条件に一致する過去の会話は見つかりませんでした。キーワードや期間を変えて再検索できます。",
				results: [],
			});
		}

		return JSON.stringify({
			success: true,
			message: `過去の会話が${records.length}件見つかりました（新しい順、本文は200文字まで）。必要に応じてこの内容を踏まえて返答してください。`,
			results: records.map((r) => toResultEntry(r, 200)),
		});
	},

	// 特定トピックの要約用ログ取得（§3.12.2: トピック要約）
	async summarizeConversationTopic(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const keyword = asOptionalString(args.keyword);
		const from = asOptionalString(args.from);
		const to = asOptionalString(args.to);

		if (!keyword && !from && !to) {
			return JSON.stringify({
				success: false,
				message:
					"要約対象を特定するため、キーワードまたは期間（from/to）のいずれかを指定してください。",
			});
		}

		// §3.12.3: 検索結果が多い場合は上位N件（デフォルト10件）に絞る。
		// 11件取得して10件に切り詰めることで「絞り込みが発生したか」を判定する。
		const found = searchMessages(ctx.userId, ctx.botId, {
			keyword,
			from,
			to,
			limit: 11,
		});
		const narrowed = found.length > 10;
		const records = found.slice(0, 10);

		if (records.length === 0) {
			return JSON.stringify({
				success: true,
				message:
					"条件に一致する過去の会話は見つかりませんでした。その旨をユーザーへ伝えてください。",
				logs: [],
			});
		}

		// 要約しやすいよう時系列（古い順）に並べ替えて返す
		const logs = records.reverse().map((r) => toResultEntry(r, 1000));

		return JSON.stringify({
			success: true,
			message: `${logs.length}件の会話ログを取得しました（時系列順）${narrowed ? "。該当が多いため新しい順の上位10件に絞っています" : ""}。この内容をユーザーの依頼に沿って要約して提示してください。`,
			logs,
		});
	},
};

// ─── Module Export ───────────────────────────────────────────────────────────

/** 会話ログ検索・要約 FunctionModule（functions/index.ts でレジストリへマージする） */
export const conversationFunctions: FunctionModule = {
	declarations,
	handlers,
};
