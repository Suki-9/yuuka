import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { addAuditLog } from "../db/auditRepo.js";
import {
	addBotMember,
	isBotMember,
	listBotMembers,
	removeBotMember,
} from "../db/botAttributesRepo.js";
import {
	appendBotGuildNote,
	appendBotUserNote,
	BOT_NOTE_MAX_LENGTH,
	getBotGuildNote,
	getBotUserNote,
	setBotGuildNote,
	setBotUserNote,
} from "../db/botNoteRepo.js";
import { getBotById } from "../db/botRepo.js";
import {
	type MessageLogRecord,
	searchGuildMessages,
} from "../db/messageLogRepo.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

// ─── 汎用モード（MCPアシスタント）専用 Function 群 ───────────────────────────
// bot_attributes_requirements.md §4.3.3（利用メンバー管理）/ §4.6（メモリ2層）。
// これらのモジュールは汎用モードのレジストリにのみマージされ、秘書プリセットでは使われない。
// ギルドスコープの Function は ctx.guildId を必須とする（owner DM では宣言自体を含めない）。

/** ハンドラ共通: ギルドコンテキスト必須チェック */
function requireGuild(ctx: ToolContext): string | null {
	if (!ctx.guildId) {
		return JSON.stringify({
			success: false,
			message: "この機能はサーバー（ギルド）内の会話でのみ利用できます。",
		});
	}
	return null;
}

/** Discordメンション形式（<@123> / <@!123>）または生IDからユーザーIDを抽出する */
function extractUserId(value: unknown): string | null {
	const raw = String(value ?? "").trim();
	const mention = raw.match(/^<@!?(\d{5,25})>$/);
	if (mention) return mention[1];
	if (/^\d{5,25}$/.test(raw)) return raw;
	return null;
}

// ─── 利用メンバー管理（汎用モードの core に含める。要件 §4.3.3） ──────────────

const memberDeclarations: FunctionDeclaration[] = [
	{
		name: "addBotMember",
		description:
			"このBotを使えるメンバーに新しい人を追加する。\n" +
			"・例:「@xx を追加して」「○○さんも使えるようにして」と頼まれた時に呼ぶ。\n" +
			"・user_id には発言の中のメンション（<@数字> の形）か、DiscordユーザーIDの数字をそのまま渡す。\n" +
				"・追加された人は、このサーバーでBotにメンションすれば使えるようになる。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				user_id: {
					type: SchemaType.STRING,
					description:
						"追加する人のメンション（例: '<@123456789012345678>'）またはDiscordユーザーIDの数字。",
				},
			},
			required: ["user_id"],
		},
	},
	{
		name: "removeBotMember",
		description:
			"このBotを使えるメンバーから人を外す。\n" +
				"・外せるのは「本人が自分自身を外す時」か「Bot作成者（owner）が外す時」だけ。\n" +
			"・誰かが他の人を外すよう頼んできた時は実行せず、その権限がないことを伝える。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				user_id: {
					type: SchemaType.STRING,
					description:
						"外す人のメンションまたはDiscordユーザーIDの数字。「私を外して」なら話している本人のID。",
				},
			},
			required: ["user_id"],
		},
	},
	{
		name: "listBotMembers",
		description:
			"このサーバーでBotを使えるメンバーの一覧（DiscordユーザーID）を取り出す。\n" +
				"・例:「誰が使えるの？」「メンバー一覧を見せて」と聞かれた時に呼ぶ。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
];

const memberHandlers: FunctionModule["handlers"] = {
	addBotMember(ctx: ToolContext, args: Record<string, unknown>): string {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;

		const targetId = extractUserId(args.user_id);
		if (!targetId) {
			return JSON.stringify({
				success: false,
				message:
					"ユーザーIDを認識できませんでした。メンション（<@...>）またはユーザーIDの数字で指定してください。",
			});
		}

		if (isBotMember(ctx.botId, ctx.guildId!, targetId)) {
			return JSON.stringify({
				success: true,
				message: "そのユーザーは既に利用メンバーです。",
			});
		}

		const added = addBotMember(ctx.botId, ctx.guildId!, targetId, ctx.userId);
		if (added) {
			addAuditLog(
				ctx.userId,
				"bot.member_add",
				`${ctx.botId}:${ctx.guildId}:${targetId}`,
			);
		}
		return JSON.stringify({
			success: added,
			message: added
				? `<@${targetId}> を利用メンバーに追加しました。メンションで利用できるようになったことを伝えてください。`
				: "メンバーの追加に失敗しました。",
		});
	},

	removeBotMember(ctx: ToolContext, args: Record<string, unknown>): string {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;

		const targetId = extractUserId(args.user_id);
		if (!targetId) {
			return JSON.stringify({
				success: false,
				message:
					"ユーザーIDを認識できませんでした。メンション（<@...>）またはユーザーIDの数字で指定してください。",
			});
		}

		// 権限: 本人による自己削除 or owner のみ（要件 §4.3.3 / §10-10）
		const ownerId = getBotById(ctx.botId)?.user_id;
		const isSelf = targetId === ctx.userId;
		const isOwner = ctx.userId === ownerId;
		if (!isSelf && !isOwner) {
			return JSON.stringify({
				success: false,
				message:
					"他のメンバーを削除できるのはBot作成者のみです。本人が「私を外して」と依頼するか、作成者に依頼してください。",
			});
		}

		const removed = removeBotMember(ctx.botId, ctx.guildId!, targetId);
		if (removed) {
			addAuditLog(
				ctx.userId,
				"bot.member_remove",
				`${ctx.botId}:${ctx.guildId}:${targetId}`,
			);
		}
		return JSON.stringify({
			success: removed,
			message: removed
				? `<@${targetId}> を利用メンバーから外しました。`
				: "そのユーザーは利用メンバーに登録されていません。",
		});
	},

	listBotMembers(ctx: ToolContext): string {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;

		const members = listBotMembers(ctx.botId, ctx.guildId!);
		const ownerId = getBotById(ctx.botId)?.user_id;
		return JSON.stringify({
			success: true,
			owner: ownerId ? `<@${ownerId}>（Bot作成者・常に利用可）` : null,
			members: members.map((m) => ({
				user: `<@${m.user_id}>`,
				added_at: m.created_at,
			})),
			count: members.length,
			message: "メンション表記（<@...>）はそのまま返信に使えます。",
		});
	},
};

/** 利用メンバー管理 FunctionModule（汎用モードの core。ギルド会話でのみマージする） */
export const botMemberFunctions: FunctionModule = {
	declarations: memberDeclarations,
	handlers: memberHandlers,
};

// ─── 個人ノート（bot × ユーザー単位。要件 §4.6.2） ───────────────────────────

const myNoteDeclarations: FunctionDeclaration[] = [
	{
		name: "appendMyNote",
		description:
			"話している本人について長く変わらない情報を、その人専用の個人ノートに1行書き足す。\n" +
				"・好み・役割・背景知識など「覚えておいて」と言われたことを保存する。\n" +
			"・個人ノートはその人が話しかけた時だけ読み込まれ、他のメンバーには見えない。\n" +
			"・サーバー全体で共有すべき情報（ルール・用語・運用手順）→ 代わりに appendGuildNote を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description:
						"覚えておく短い1行の文章（例: '〇〇さんはイベント企画担当'）。",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "getMyNote",
		description:
			"話している本人の個人ノートの全文を取り出す。\n" +
				"・例:「私について何を覚えてる？」と聞かれた時や、整理や重複の確認をしたい時に使う。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "setMyNote",
		description:
			"話している本人の個人ノートを、渡した全文でまるごと書き換える（古い内容は消える）。\n" +
				"・「〇〇を忘れて」や内容を整理したい時に使う。\n" +
			"・誤って消さないため、先に getMyNote で今の中身を読み、書き換え後の全文を本人に見せて承認を得てから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description: `整理し直したノートの全文（${BOT_NOTE_MAX_LENGTH.toLocaleString()}文字まで。改行で区切った箇条書きがおすすめ）。`,
				},
			},
			required: ["content"],
		},
	},
];

const myNoteHandlers: FunctionModule["handlers"] = {
	appendMyNote(ctx: ToolContext, args: Record<string, unknown>): string {
		const content = String(args.content ?? "").trim();
		if (!content) {
			return JSON.stringify({
				success: false,
				message: "記憶する内容が空です。",
			});
		}
		try {
			const full = appendBotUserNote(ctx.botId, ctx.userId, content);
			return JSON.stringify({
				success: true,
				message: "個人ノートに追記しました📝",
				total_length: full.length,
				max_length: BOT_NOTE_MAX_LENGTH,
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: (err as Error).message,
			});
		}
	},

	getMyNote(ctx: ToolContext): string {
		const note = getBotUserNote(ctx.botId, ctx.userId);
		return JSON.stringify({
			success: true,
			content: note,
			length: note.length,
			max_length: BOT_NOTE_MAX_LENGTH,
		});
	},

	setMyNote(ctx: ToolContext, args: Record<string, unknown>): string {
		const content = String(args.content ?? "");
		try {
			setBotUserNote(ctx.botId, ctx.userId, content);
			return JSON.stringify({
				success: true,
				message: "個人ノートを更新しました📝",
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

/** 個人ノート FunctionModule（汎用モードの memory。ギルド・owner DM の両方でマージする） */
export const botPersonalNoteFunctions: FunctionModule = {
	declarations: myNoteDeclarations,
	handlers: myNoteHandlers,
};

// ─── 共有ノート + ギルド会話要約（bot × ギルド単位。要件 §4.6） ───────────────
//
// キーワードによる受動的なギルド会話検索（旧 searchConversationLogs）は、シナプスの
// L2 連想想起へ統合・置換されたため廃止。時系列の文脈が本質的に重要で連想想起では
// 代替できない summarizeConversationTopic（要約用ログの時系列取得）のみ維持する。

/** 本文を最大文字数で切り詰める */
function truncateContent(content: string, maxLength: number): string {
	const chars = Array.from(content);
	if (chars.length <= maxLength) return content;
	return `${chars.slice(0, maxLength).join("")}…`;
}

function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function toResultEntry(record: MessageLogRecord, maxContentLength: number) {
	return {
		role: record.role,
		created_at: record.created_at,
		content: truncateContent(record.content, maxContentLength),
	};
}

const guildMemoryDeclarations: FunctionDeclaration[] = [
	{
		name: "appendGuildNote",
		description:
			"このサーバー全体で共有したい知識を、共有ノートに1行書き足す。\n" +
				"・サーバーのルール・用語・運用手順・よくある質問への答えなどを保存する。\n" +
			"・共有ノートは利用メンバー全員との会話で読み込まれる。\n" +
				"・話している本人だけに関する情報 → 代わりに appendMyNote を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description:
						"覚えておく短い1行の文章（例: 'イベント告知は #お知らせ チャンネルで行う'）。",
				},
			},
			required: ["content"],
		},
	},
	{
		name: "getGuildNote",
		description:
			"このサーバーの共有ノートの全文を取り出す。\n" +
				"・例:「サーバーのルールは？」と聞かれた時や、整理や重複の確認をしたい時に使う。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "setGuildNote",
		description:
			"このサーバーの共有ノートを、渡した全文でまるごと書き換える（古い内容は消える）。\n" +
				"・内容を整理したい時や、項目の削除を頼まれた時に使う。\n" +
			"・共有情報を誤って消さないため、先に getGuildNote で今の中身を読み、書き換え後の全文をユーザーに見せて承認を得てから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				content: {
					type: SchemaType.STRING,
					description: `整理し直したノートの全文（${BOT_NOTE_MAX_LENGTH.toLocaleString()}文字まで。改行で区切った箇条書きがおすすめ）。`,
				},
			},
			required: ["content"],
		},
	},
	{
		name: "summarizeConversationTopic",
		description:
			"このサーバーの過去の会話から、ある話題のログを古い順に取り出す（要約のための材料集め）。\n" +
				"・例:「〇〇の議論をまとめて」と頼まれた時に呼ぶ。\n" +
			"・このツール自体は要約しない。返ってきた会話ログを読んで、あなたが依頼に沿って要約して伝える。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				keyword: {
					type: SchemaType.STRING,
					description:
						"要約したい話題のキーワード。省略=期間だけで検索する。",
				},
				from: {
					type: SchemaType.STRING,
					description: "検索する期間の開始日。形式: YYYY-MM-DD。省略可。",
				},
				to: {
					type: SchemaType.STRING,
					description:
						"検索する期間の終了日。形式: YYYY-MM-DD。その日の終わりまで含む。省略可。",
				},
			},
		},
	},
];

const guildMemoryHandlers: FunctionModule["handlers"] = {
	appendGuildNote(ctx: ToolContext, args: Record<string, unknown>): string {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;
		const content = String(args.content ?? "").trim();
		if (!content) {
			return JSON.stringify({
				success: false,
				message: "記憶する内容が空です。",
			});
		}
		try {
			const full = appendBotGuildNote(ctx.botId, ctx.guildId!, content);
			return JSON.stringify({
				success: true,
				message:
					"共有ノートに追記しました📝（このサーバーの利用メンバー全員と共有されます）",
				total_length: full.length,
				max_length: BOT_NOTE_MAX_LENGTH,
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: (err as Error).message,
			});
		}
	},

	getGuildNote(ctx: ToolContext): string {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;
		const note = getBotGuildNote(ctx.botId, ctx.guildId!);
		return JSON.stringify({
			success: true,
			content: note,
			length: note.length,
			max_length: BOT_NOTE_MAX_LENGTH,
		});
	},

	setGuildNote(ctx: ToolContext, args: Record<string, unknown>): string {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;
		const content = String(args.content ?? "");
		try {
			setBotGuildNote(ctx.botId, ctx.guildId!, content);
			return JSON.stringify({
				success: true,
				message: "共有ノートを更新しました📝",
				total_length: content.length,
			});
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: (err as Error).message,
			});
		}
	},

	async summarizeConversationTopic(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const guildError = requireGuild(ctx);
		if (guildError) return guildError;

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

		const found = searchGuildMessages(ctx.botId, ctx.guildId!, {
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

		const logs = records.reverse().map((r) => toResultEntry(r, 1000));

		return JSON.stringify({
			success: true,
			message: `${logs.length}件の会話ログを取得しました（時系列順）${narrowed ? "。該当が多いため新しい順の上位10件に絞っています" : ""}。この内容をユーザーの依頼に沿って要約して提示してください。`,
			logs,
		});
	},
};

/** 共有ノート + ギルド会話要約 FunctionModule（汎用モードの memory。ギルド会話でのみマージする） */
export const botGuildMemoryFunctions: FunctionModule = {
	declarations: guildMemoryDeclarations,
	handlers: guildMemoryHandlers,
};
