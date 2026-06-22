import { SchemaType } from "@google/generative-ai";
import type { FunctionDeclaration } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { searchMessages, type MessageLogRecord } from "../db/messageLogRepo.js";

// ─── 会話ログ要約 Function（§3.12） ─────────────────────────────────────────
//
// SQLiteに永続保存された全会話履歴（§7）を対象に、特定トピックの過去のやり取りを
// 時系列順に取得して LLM に要約させる（summarizeConversationTopic）。時系列の文脈が
// 本質的に重要なため、シナプスの連想想起では代替できない機能として維持する。
// キーワードによる受動的な過去会話検索（旧 searchConversationLogs）は、シナプス
// エンジンの L2 連想想起（自動・能動的な想起。docs/design/synapse_cognitive_architecture.md §1.2）
// へ統合・置換されたため廃止した。
// プライバシー配慮（§3.12.3）: 取得対象は ctx.userId（本人）の会話のみ。

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

/** 会話ログ要約 FunctionModule（functions/index.ts でレジストリへマージする） */
export const conversationFunctions: FunctionModule = {
	declarations,
	handlers,
};
