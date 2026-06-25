import { randomUUID } from "node:crypto";
import {
	ActionRowBuilder,
	type APIActionRowComponent,
	type APIComponentInMessageActionRow,
	ButtonBuilder,
	ButtonStyle,
	type EmbedBuilder,
} from "discord.js";
import { config } from "../config.js";
import { clearContext } from "../db/messageLogRepo.js";
import { type ChatMessage, processMessage } from "../gemini.js";
import type { SessionUser, TurnAsyncDelivery } from "../types/contracts.js";
import { consumeRateLimit, rateLimitMessage } from "./botRateLimit.js";
import { getUserGenAI } from "./llmClient.js";

// ─── クライアント非依存の汎用チャット アダプタ（desktop_client backend_api.md §3） ──
// WebSocket（や将来の他チャンネル）と会話コア processMessage() の薄いアダプタ。
// 送出はトランスポート非依存の `send` コールバックに委ね、processMessage は無改修で呼ぶ。

/** WS 出力フレーム（backend_api.md §3.3）。クライアントの model.rs と一致させる。 */
export type OutboundFrame =
	| {
			type: "ready";
			user: SessionUser;
			bot: BotInfo;
			bots: BotInfo[];
			maxUploadMb: number;
	  }
	| { type: "status"; state: "thinking" | "writing" }
	| { type: "interim"; text: string }
	| {
			type: "done";
			messageId?: string;
			text: string;
			embeds: unknown[];
			files: SerializedFile[];
			deferred: boolean;
			/** 対話コンポーネント（Discord API JSON の action row 群。ws_components.md §1-2） */
			components?: SerializedComponents;
	  }
	| {
			type: "push";
			text: string;
			embeds: unknown[];
			files: SerializedFile[];
			/** components を含む場合は突合キーとして必須（ws_components.md §2）。 */
			messageId?: string;
			components?: SerializedComponents;
	  }
	| {
			// interaction の結果として履歴中の該当メッセージを書き換える（ws_components.md §2）。
			type: "update";
			messageId: string;
			text?: string;
			embeds?: unknown[];
			components?: SerializedComponents;
	  }
	| { type: "error"; code: ChatErrorCode; message: string };

/** 直列化済みの対話コンポーネント（= Discord API JSON の action row 配列）。 */
export type SerializedComponents = APIActionRowComponent<APIComponentInMessageActionRow>[];

export interface BotInfo {
	id: string;
	name: string;
	discord_avatar_url: string | null;
	/** プライマリ Bot 判定（クライアントのホットキー登録可否に使う）。 */
	primary: boolean;
}

export interface SerializedFile {
	name: string;
	mime: string;
	data: string; // base64
}

export type ChatErrorCode =
	| "no_gemini_key"
	| "rate_limited"
	| "too_large"
	| "internal"
	| "unauthorized";

/** クライアント → サーバの発話フレーム（§3.2）。botId は接続束縛のため含まない。 */
export interface IncomingMsg {
	text?: string;
	image?: { mime: string; data: string };
	audio?: { mime: string; data: string };
	replyToId?: string;
}

type Send = (frame: OutboundFrame) => void;

/**
 * ProcessResult を desktop 中立な JSON へ直列化する（architecture.md §7）。
 * embeds は discord.js EmbedBuilder → APIEmbed(JSON)、files は PNG Buffer → base64。
 * embed の image: "attachment://name" 参照はクライアントが files の同名添付へ解決する。
 */
export function serializeRich(r: {
	text: string;
	embeds: EmbedBuilder[];
	files: { attachment: Buffer; name: string }[];
	/** ActionRowBuilder（.toJSON() で API JSON 化）または既に API JSON の action row。 */
	components?: (
		| ActionRowBuilder<ButtonBuilder>
		| APIActionRowComponent<APIComponentInMessageActionRow>
	)[];
}): {
	text: string;
	embeds: unknown[];
	files: SerializedFile[];
	components?: SerializedComponents;
} {
	return {
		text: r.text,
		embeds: r.embeds.map((e) => e.toJSON()),
		files: r.files.map((f) => ({
			name: f.name,
			mime: "image/png",
			data: f.attachment.toString("base64"),
		})),
		...(r.components ? { components: serializeComponents(r.components) } : {}),
	};
}

/** ActionRowBuilder / API JSON 混在の action row 群を Discord API JSON へ統一する。 */
export function serializeComponents(
	rows: (
		| ActionRowBuilder<ButtonBuilder>
		| APIActionRowComponent<APIComponentInMessageActionRow>
	)[],
): SerializedComponents {
	return rows.map((row) =>
		row instanceof ActionRowBuilder ? row.toJSON() : row,
	);
}

/** 例外をクライアント向けエラーコードへ分類する。 */
function classifyError(e: unknown): ChatErrorCode {
	const msg = e instanceof Error ? e.message : String(e);
	if (/rate|429|quota|制限/i.test(msg)) return "rate_limited";
	return "internal";
}

/**
 * 1 件の発話を処理し、進捗/結果を `send` で WS フレーム化する。
 * - Gemini キー未設定は processMessage を呼ぶ前に弾く（no_gemini_key）。
 * - 進捗 onStatusChange("idle") は送らない（クライアントはステータス解除を done/push で行う）。
 * - 重い処理（deferred）は onInterim → interim、deliverFinal → push に流す（notifier は通さない）。
 */
export async function handleChatMessage(
	send: Send,
	user: SessionUser,
	botId: string,
	msg: IncomingMsg,
): Promise<void> {
	const userId = user.discordId;

	// 往復実証用デモ（ws_components.md §5）: フラグ ON かつ本文完全一致なら、
	// Gemini を介さず即座にボタン付き done を返す（コンポーネント基盤の純粋な疎通確認）。
	if (config.desktopDemoComponents && (msg.text ?? "") === "/__demo_buttons") {
		const nonce = randomUUID().slice(0, 8);
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`demo_echo:${nonce}`)
				.setLabel("確認")
				.setStyle(ButtonStyle.Primary),
		);
		send({
			type: "done",
			messageId: randomUUID(),
			...serializeRich({
				text: "デモ: 下のボタンを押してください。",
				embeds: [],
				files: [],
				components: [row.toJSON()],
			}),
			deferred: false,
		});
		return;
	}

	// Gemini キー未設定の事前判定（processMessage は no-key 時も例外を投げず ⚠️ テキストを返すため）。
	if (!getUserGenAI(userId)) {
		send({
			type: "error",
			code: "no_gemini_key",
			message:
				"Gemini APIキーが未設定です。Web ダッシュボードで設定してください。",
		});
		return;
	}

	// レート制限（DM/秘書のため guildId は空。botRateLimit のユーザー軸を流用）。
	const rl = await consumeRateLimit(botId, "", userId);
	if (!rl.allowed && rl.exceeded) {
		send({
			type: "error",
			code: "rate_limited",
			message: rateLimitMessage(rl.exceeded),
		});
		return;
	}

	const chat: ChatMessage = {
		text: msg.text ?? "",
		imageData: msg.image
			? { data: msg.image.data, mimeType: msg.image.mime }
			: undefined,
		audioData: msg.audio
			? { data: msg.audio.data, mimeType: msg.audio.mime }
			: undefined,
		replyToMsgId: msg.replyToId,
	};

	const onStatusChange = (state: "thinking" | "writing" | "idle") => {
		if (state !== "idle") send({ type: "status", state });
	};

	const asyncDelivery: TurnAsyncDelivery = {
		onInterim: (text) => send({ type: "interim", text }),
		deliverFinal: async (payload) => {
			send({
				type: "push",
				// components を載せる場合は突合キーとして messageId が必須（ws_components.md §2）。
				...(payload.components ? { messageId: randomUUID() } : {}),
				...serializeRich({
					text: payload.content,
					embeds: payload.embeds,
					files: payload.files,
					components: payload.components,
				}),
			});
		},
	};

	try {
		const r = await processMessage(
			botId,
			userId,
			chat,
			onStatusChange,
			asyncDelivery,
		);
		// サーバ側メッセージID（クライアントの差分描画・返信チェーン・interaction 突合のキー）。
		// processMessage は ID を返さないため合成する。
		const messageId = randomUUID();

		// processMessage が付与した components（通常は無し）。
		let components = r.components;

		// 往復実証用デモ（ws_components.md §5。フラグ ON かつ本文が完全一致のときのみ）。
		if (
			config.desktopDemoComponents &&
			(msg.text ?? "") === "/__demo_buttons"
		) {
			const nonce = randomUUID().slice(0, 8);
			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`demo_echo:${nonce}`)
					.setLabel("確認")
					.setStyle(ButtonStyle.Primary),
			);
			components = [row.toJSON()];
		}

		send({
			type: "done",
			messageId,
			...serializeRich({ ...r, components }),
			deferred: r.deferred ?? false,
		});
	} catch (e) {
		console.error("[chatChannel] processMessage failed:", e);
		send({
			type: "error",
			code: classifyError(e),
			message: "処理中にエラーが発生しました。時間をおいて再試行してください。",
		});
	}
}

/** §3.2: 会話リセット（接続束縛 Bot の秘書コンテキストをクリアする）。 */
export async function handleReset(
	userId: string,
	botId: string,
): Promise<void> {
	await clearContext(userId, botId);
}
