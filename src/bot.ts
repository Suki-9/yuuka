import {
	ActionRowBuilder,
	ActivityType,
	ButtonBuilder,
	ButtonStyle,
	Client,
	Events,
	GatewayIntentBits,
	type Interaction,
	type Message,
	Partials,
} from "discord.js";
import { isBotMember, isGuildAllowed } from "./db/botAttributesRepo.js";
import {
	acceptShareInvite,
	getBotById,
	getBotDiscordConfig,
	getShareById,
	isBotSuspended,
	listAllBots,
	listBotsForUser,
	revokeShare,
	updateBotDiscordProfile,
} from "./db/botRepo.js";
import { getPersonaById, importPersona } from "./db/personaRepo.js";
import { isRegisteredUser } from "./db/userRepo.js";
import {
	type ChatMessage,
	processBotDmMessage,
	processGuildMessage,
	processMessage,
} from "./gemini.js";
import { isGuildAssistantBot } from "./services/botCapabilities.js";
import { consumeRateLimit, rateLimitMessage } from "./services/botRateLimit.js";
import { getBotGenAI } from "./services/llmClient.js";
import { sendToUser } from "./services/notifier.js";
import { parseReceipt } from "./services/receiptParser.js";
import type { TurnAsyncDelivery } from "./types/contracts.js";
import { decryptText } from "./utils/crypto.js";
import { toDiscordMarkdown } from "./utils/discordMarkdown.js";

const DISCORD_CLIENT_OPTIONS = {
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
		GatewayIntentBits.DirectMessages,
	],
	partials: [Partials.Channel, Partials.Message],
};

// 対応する音声フォーマット（§3.14.4: Gemini APIサポートに準拠）
const SUPPORTED_AUDIO_TYPES = [
	"audio/ogg",
	"audio/mpeg",
	"audio/mp3",
	"audio/wav",
	"audio/x-wav",
	"audio/mp4",
	"audio/x-m4a",
	"audio/m4a",
	"audio/aac",
	"audio/flac",
];

// デフォルト（共有）クライアント。
// discord.js v14 は destroy 済み Client の再ログインを保証しないため、
// トークン更新時は restartDefaultBot が新しいインスタンスへ差し替える
// （ESM の named import はライブバインディングなので参照側へも即時反映される）。
export let client: Client = new Client(DISCORD_CLIENT_OPTIONS);

// Botごとのカスタムクライアント: Map<botId, Client>
export const customClients = new Map<string, Client>();

/**
 * Bot IDに応じた適切なBotクライアントを取得する
 * ユーザーが独自のDiscord Tokenを設定している場合はそれを優先し、無ければデフォルトクライアントを返す
 */
export function getBotClientForUser(botId: string): Client {
	const custom = customClients.get(botId);
	if (custom && custom.readyAt) {
		return custom;
	}
	return client;
}

export function setBotStatus(
	botClient: Client,
	status: "thinking" | "writing" | "idle",
) {
	if (!botClient.user) return;
	try {
		if (status === "thinking") {
			botClient.user.setPresence({
				activities: [
					{
						name: "custom",
						type: ActivityType.Custom,
						state: "考え中...",
					},
				],
				status: "dnd",
			});
		} else if (status === "writing") {
			botClient.user.setPresence({
				activities: [
					{
						name: "custom",
						type: ActivityType.Custom,
						state: "書き込み中...",
					},
				],
				status: "online",
			});
		} else {
			botClient.user.setPresence({
				activities: [],
				status: "online",
			});
		}
	} catch (err) {
		console.error("Failed to set bot presence status:", err);
	}
}

// ─── プロフィール同期（§4.3.2: 起動時・1時間ごと・手動） ────────────────────

let profileSyncTimer: NodeJS.Timeout | null = null;

/** ログイン中の全BotクライアントからDiscordプロフィール（名前・アバター）をDBへ同期する */
export function syncAllBotProfiles(): void {
	try {
		if (client.user && client.readyAt) {
			updateBotDiscordProfile(
				"system_default",
				client.user.username,
				client.user.displayAvatarURL(),
				client.user.id,
			);
		}
		for (const [botId, customClient] of customClients.entries()) {
			if (customClient.user && customClient.readyAt) {
				updateBotDiscordProfile(
					botId,
					customClient.user.username,
					customClient.user.displayAvatarURL(),
					customClient.user.id,
				);
			}
		}
	} catch (err) {
		console.error("[Discord Bot] プロフィール定期同期に失敗しました:", err);
	}
}

function startProfileSyncTimer(): void {
	if (profileSyncTimer) return;
	profileSyncTimer = setInterval(
		() => {
			syncAllBotProfiles();
		},
		60 * 60 * 1000,
	); // 1時間ごと
	// 常駐タイマーがイベントループを生かし続けて graceful shutdown を妨げないよう unref する。
	// stopBot() での clearInterval に加えた多重防御で、watchdog 等の stopBot を経由しない
	// 終了経路でも SIGINT/SIGTERM での即時終了を保証する。
	profileSyncTimer.unref();
}

// ─── Bot共有招待への応答（§5.2.2: ボタンによる承認フロー） ───────────────────

/**
 * 共有招待DMを送信する（server.ts の共有招待ルートから呼ばれる）
 * 推奨ペルソナが設定されている場合はその情報も通知する
 */
export async function sendShareInviteDM(
	shareId: number,
	sharedUserId: string,
	botName: string,
	ownerName: string,
	recommendedPersonaName?: string,
): Promise<boolean> {
	try {
		const user = await client.users.fetch(sharedUserId);
		const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`share_accept:${shareId}`)
				.setLabel("承認する")
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(`share_decline:${shareId}`)
				.setLabel("辞退する")
				.setStyle(ButtonStyle.Secondary),
		);
		const personaInfo = recommendedPersonaName
			? `\n\nこのBotには推奨ペルソナ「**${recommendedPersonaName}**」が設定されています。承認後にインポートするか選択できます。`
			: "";
		await user.send({
			content: `📨 **${ownerName}** さんがあなたをBot「**${botName}**」に招待しました。${personaInfo}`,
			components: [row],
		});
		return true;
	} catch (err) {
		console.error(
			`[Discord Bot] 共有招待DMの送信に失敗しました (user: ${sharedUserId}):`,
			err,
		);
		return false;
	}
}

/**
 * 登録時の本人確認コードを、主張された Discord ID 宛にデフォルトBotからDMする（G1: DMチャレンジ方式）。
 * Botがユーザーとサーバーを共有していない／DMが閉じている場合は false。コードはログに出さない。
 */
export async function sendRegistrationCodeDM(
	discordId: string,
	code: string,
): Promise<boolean> {
	try {
		if (!client.isReady()) return false;
		const user = await client.users.fetch(discordId);
		await user.send({
			content:
				`🔐 **Yuuka アカウント登録の確認コード**\n\n` +
				`確認コード: **${code}**\n\n` +
				`Web登録画面にこのコードを入力すると登録が完了します（10分間有効）。\n` +
				`※ このDMに心当たりがない場合は、誰かがあなたのDiscord IDで登録を試みています。コードは入力しないでください。`,
		});
		return true;
	} catch (err) {
		console.error(
			`[Discord Bot] 登録確認コードのDM送信に失敗しました (user: ${discordId}):`,
			(err as Error).message,
		);
		return false;
	}
}

/** ボタンインタラクション処理（共有招待の承認・推奨ペルソナのインポート） */
async function handleInteraction(interaction: Interaction): Promise<void> {
	if (!interaction.isButton()) return;

	const [action, idStr] = interaction.customId.split(":");
	try {
		if (action === "share_accept" || action === "share_decline") {
			const share = getShareById(parseInt(idStr, 10));
			if (!share || share.shared_user_id !== interaction.user.id) {
				await interaction.reply({
					content: "この招待はあなた宛ではないか、既に無効です。",
					ephemeral: true,
				});
				return;
			}
			if (share.status !== "pending") {
				await interaction.reply({
					content: "この招待は既に処理済みです。",
					ephemeral: true,
				});
				return;
			}

			if (action === "share_decline") {
				revokeShare(share.bot_id, share.shared_user_id);
				await interaction.update({
					content: "招待を辞退しました。",
					components: [],
				});
				return;
			}

			acceptShareInvite(share.bot_id, share.shared_user_id);
			const bot = getBotById(share.bot_id);
			await interaction.update({
				content: `✅ Bot「**${bot?.name ?? share.bot_id}**」へのアクセスが有効になりました！`,
				components: [],
			});

			// 推奨ペルソナが設定されている場合、インポート確認を表示（§5.2.2）
			if (bot?.recommended_persona_id) {
				const persona = getPersonaById(bot.recommended_persona_id);
				if (persona && persona.is_public === 1) {
					const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setCustomId(`persona_import:${persona.id}`)
							.setLabel(`ペルソナ「${persona.name.slice(0, 60)}」をインポート`)
							.setStyle(ButtonStyle.Primary),
					);
					await interaction.followUp({
						content: `このBotの推奨ペルソナをインポートしますか？（任意です。インポート後は独立したコピーとなります）`,
						components: [row],
					});
				}
			}
			return;
		}

		if (action === "persona_import") {
			if (!isRegisteredUser(interaction.user.id)) {
				await interaction.reply({
					content: "先にユーザー登録を完了してください。",
					ephemeral: true,
				});
				return;
			}
			const result = importPersona(interaction.user.id, parseInt(idStr, 10));
			if (result) {
				await interaction.update({
					content: `✅ ペルソナをインポートしました。管理画面の「ペルソナ」から適用できます。`,
					components: [],
				});
			} else {
				await interaction.update({
					content:
						"ペルソナのインポートに失敗しました（非公開化された可能性があります）。",
					components: [],
				});
			}
			return;
		}
	} catch (err) {
		console.error("[Discord Bot] インタラクション処理エラー:", err);
		try {
			if (
				interaction.isRepliable() &&
				!interaction.replied &&
				!interaction.deferred
			) {
				await interaction.reply({
					content: "処理中にエラーが発生しました。",
					ephemeral: true,
				});
			}
		} catch {}
	}
}

/**
 * デフォルトBot用クライアントに必要な全リスナーを登録する。
 * 初期化時と restartDefaultBot での差し替え時の両方で使い、登録漏れ・二重登録を防ぐ。
 */
function attachDefaultClientHandlers(botClient: Client): void {
	// REST/Gateway起因のエラーでプロセスが落ちないようにする。
	// discord.js の Client は 'error' リスナーが無いと、非同期リスナー内の例外が
	// 'error' イベントとして emit された際に Node プロセスごとクラッシュする。
	botClient.on(Events.Error, (err) => {
		console.error(
			"[Discord Bot] デフォルトクライアントでエラーが発生しました:",
			err,
		);
	});

	botClient.on(Events.ClientReady, (c) => {
		console.log(
			`✅ デフォルトBot: ${c.user.tag} としてログインしました (clientReady)`,
		);
		setBotStatus(botClient, "idle");

		// Discordからプロフィールを同期（起動時 §4.3.2）
		try {
			const avatarUrl = c.user.displayAvatarURL();
			updateBotDiscordProfile(
				"system_default",
				c.user.username,
				avatarUrl,
				c.user.id,
			);
			console.log(
				`[Discord Bot] デフォルトBotのプロフィールを同期しました: ${c.user.username}`,
			);
		} catch (err) {
			console.error(
				"[Discord Bot] デフォルトBotのプロフィールの同期に失敗しました:",
				err,
			);
		}

		startProfileSyncTimer();
	});

	botClient.on(Events.InteractionCreate, handleInteraction);
	setupMessageListener(botClient);
}

attachDefaultClientHandlers(client);

/**
 * 指定したBotクライアントにメッセージハンドラーを設定する
 */
/**
 * 例外を投げない安全な返信ヘルパー。
 * トークン更新（destroy→login）やシャットダウン中のレース、権限不足等で
 * 送信が失敗してもハンドラ全体（ひいてはプロセス）を巻き込まないようにする。
 */
async function safeReply(
	message: Message,
	options: Parameters<Message["reply"]>[0],
): Promise<boolean> {
	try {
		await message.reply(options);
		return true;
	} catch (err) {
		console.error("[Discord Bot] 返信の送信に失敗しました:", err);
		return false;
	}
}

// ─── 汎用モード（MCPアシスタント）のメッセージハンドリング ────────────────────
// bot_attributes_requirements.md §4.3: 許可ギルド内のメンション/返信に応答し、
// 利用メンバー制・Bot専用キー必須・レート制限の防衛線を通してから LLM を呼ぶ。

/** メンバー外ユーザーへの利用案内のスロットル（連投スパムでDiscordレート制限を踏まない） */
const guidanceThrottle = new Map<string, number>();
const GUIDANCE_THROTTLE_MS = 5 * 60 * 1000;

/** メンバー外のメンションへ定型の利用案内を返す（LLMは呼ばず、ログ・ノートにも記録しない §4.3.3） */
async function sendNonMemberGuidance(
	botId: string,
	message: Message,
): Promise<void> {
	const throttleKey = `${botId}:${message.author.id}`;
	const last = guidanceThrottle.get(throttleKey);
	if (last && Date.now() - last < GUIDANCE_THROTTLE_MS) return;
	guidanceThrottle.set(throttleKey, Date.now());

	await safeReply(
		message,
		"👋 このBotは利用メンバー制です。既存の利用メンバーかBot作成者に「メンバーに追加して」と依頼してもらうと利用できます。",
	);
}

/** ギルド内の表示名を解決する（ニックネーム → グローバル表示名 → ユーザー名） */
function resolveDisplayName(message: Message): string {
	return (
		message.member?.displayName ||
		message.author.displayName ||
		message.author.username
	);
}

/**
 * 汎用モードBotのメッセージ処理本体。
 * 防衛線の通過後に gemini.ts の processGuildMessage / processBotDmMessage を呼び出す。
 */
async function handleAssistantMessage(
	botClient: Client,
	botId: string,
	message: Message,
): Promise<void> {
	const bot = getBotById(botId);
	if (!bot) return;
	const ownerId = bot.user_id;
	const isDM = !message.guild;

	// ── DM: owner からのもののみ応答（要件 §4.3.2。owner 以外は黙殺） ──
	if (isDM && message.author.id !== ownerId) return;

	let guildId: string | null = null;

	if (!isDM) {
		// ── ギルド許可リスト（要件 §6: 未許可ギルドは応答も記録もしない） ──
		guildId = message.guild!.id;
		if (!isGuildAllowed(botId, guildId)) return;
	}

	// ── メンション / Botへの返信にのみ応答（要件 §4.3.2。DMは常に対象） ──
	let isReplyToBot = false;
	let referencedMsg: Message | null = null;
	if (message.reference?.messageId) {
		try {
			referencedMsg = await message.channel.messages.fetch(
				message.reference.messageId,
			);
			if (referencedMsg?.author.id === botClient.user?.id) {
				isReplyToBot = true;
			}
		} catch (err) {
			console.error("返信先メッセージの取得に失敗しました:", err);
		}
	}
	const isMentioned = message.mentions.has(botClient.user!);
	if (!isDM && !isMentioned && !isReplyToBot) return;

	const userId = message.author.id;

	if (!isDM) {
		// ── 利用メンバー判定（owner は常に暗黙メンバー §4.3.3） ──
		const isMember = userId === ownerId || isBotMember(botId, guildId!, userId);
		if (!isMember) {
			await sendNonMemberGuidance(botId, message);
			return;
		}

		// ── Bot専用キー必須（未設定・無効なキーのBotは応答しない §4.3.3） ──
		if (!getBotGenAI(botId)) {
			console.warn(
				`[汎用モード] Bot ${botId} はGemini APIキー未設定のため応答しません（管理UIに警告表示）。`,
			);
			return;
		}

		// ── レート制限（超過時はLLMを呼ばず定型応答 §6） ──
		const rate = await consumeRateLimit(botId, guildId!, userId);
		if (!rate.allowed) {
			await safeReply(message, rateLimitMessage(rate.exceeded!));
			return;
		}
	}

	let typingInterval: NodeJS.Timeout | null = null;

	try {
		if (
			"sendTyping" in message.channel &&
			typeof (message.channel as any).sendTyping === "function"
		) {
			const channel = message.channel as any;
			await channel
				.sendTyping()
				.catch((err: unknown) => console.error("sendTyping error:", err));
			typingInterval = setInterval(() => {
				channel
					.sendTyping()
					.catch((err: unknown) => console.error("sendTyping error:", err));
			}, 5000);
		}

		// 自Bot宛てのメンションのみ除去する。他ユーザーへのメンション（<@id>）は
		// メンバー追加依頼（「@xx を追加して」）の対象解決に必要なため残す（要件 §4.3.3）
		const botUserId = botClient.user!.id;
		const text = message.content
			.replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
			.trim();

		// 返信先メッセージのプレフィックス（DB未記録メッセージへの返信もカバー。
		// 記録がある場合の完全なチェーン解決は processGuildMessage 側で行う）
		let contextPrefix = "";
		if (referencedMsg) {
			const refAuthorName =
				referencedMsg.author.id === botClient.user?.id
					? "あなた"
					: referencedMsg.member?.displayName || referencedMsg.author.username;
			const cleanRefText = referencedMsg.content
				.replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
				.trim();
			if (cleanRefText) {
				contextPrefix = `[返信先メッセージ (${refAuthorName}): "${cleanRefText}"]\n`;
			}
		}

		const fullText = contextPrefix + text;

		// 添付（画像・音声はGeminiマルチモーダルへそのまま渡す。レシートOCR等の秘書機能は持たない）
		const imageAttachment = message.attachments.find((a) =>
			a.contentType?.startsWith("image/"),
		);
		const audioAttachment = message.attachments.find((a) => {
			const ct = (a.contentType || "").split(";")[0].trim().toLowerCase();
			return SUPPORTED_AUDIO_TYPES.includes(ct) || ct.startsWith("audio/");
		});

		const chatMessage: ChatMessage = {
			text: fullText,
			discordMsgId: message.id,
			replyToMsgId: message.reference?.messageId ?? undefined,
		};

		if (audioAttachment) {
			const audioResponse = await fetch(audioAttachment.url);
			const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
			chatMessage.audioData = {
				data: audioBuffer.toString("base64"),
				mimeType: (audioAttachment.contentType || "audio/ogg")
					.split(";")[0]
					.trim(),
			};
			if (!chatMessage.text.trim()) {
				chatMessage.text =
					"（音声メッセージを受信しました。内容を正確に文字起こしし、内容に沿って応答してください。）";
			}
		} else if (imageAttachment) {
			const imageResponse = await fetch(imageAttachment.url);
			const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
			chatMessage.imageData = {
				data: imageBuffer.toString("base64"),
				mimeType: imageAttachment.contentType || "image/jpeg",
			};
		} else if (!fullText.trim()) {
			await safeReply(message, "何かお手伝いできることはありますか？");
			return;
		}

		const statusCallback = (status: "thinking" | "writing" | "idle") => {
			setBotStatus(botClient, status);
		};

		// 重い処理の非同期化ハンドル（Goal 2）。
		const asyncDelivery: TurnAsyncDelivery = {
			onInterim: async (interimText: string) => {
				if (typingInterval) {
					clearInterval(typingInterval);
					typingInterval = null;
				}
				await safeReply(message, { content: toDiscordMarkdown(interimText) });
			},
			deliverFinal: async (payload) => {
				const target = isDM
					? ({ type: "dm" } as const)
					: ({ type: "channel", id: message.channelId } as const);
				const ok = await sendToUser(
					userId,
					{
						content: payload.content,
						embeds: payload.embeds,
						files: payload.files,
					},
					target,
					botId,
				);
				// 同チャンネル送信に失敗した場合は DM へフォールバックして取りこぼしを防ぐ。
				if (!ok && !isDM) {
					await sendToUser(
						userId,
						{
							content: payload.content,
							embeds: payload.embeds,
							files: payload.files,
						},
						{ type: "dm" },
						botId,
					);
				}
			},
		};

		const speaker = { userId, displayName: resolveDisplayName(message) };
		const result = isDM
			? await processBotDmMessage(
					botId,
					speaker,
					chatMessage,
					statusCallback,
					asyncDelivery,
				)
			: await processGuildMessage(
					botId,
					guildId!,
					speaker,
					chatMessage,
					statusCallback,
					asyncDelivery,
				);

		if (typingInterval) {
			clearInterval(typingInterval);
			typingInterval = null;
		}

		if (
			!result.text &&
			result.embeds.length === 0 &&
			result.files.length === 0
		) {
			return; // 応答なし（キー未設定等）は黙殺
		}

		const attachOptions = {
			...(result.embeds.length > 0 ? { embeds: result.embeds } : {}),
			...(result.files.length > 0
				? {
						files: result.files.map((f) => ({
							attachment: f.attachment,
							name: f.name,
						})),
					}
				: {}),
		};

		// Discord非対応Markdownを互換表現へ変換（分割前の全文に適用）
		const replyText = toDiscordMarkdown(result.text);

		if (replyText.length > 2000) {
			const chunks = splitMessage(replyText, 2000);
			for (let i = 0; i < chunks.length; i++) {
				const isLast = i === chunks.length - 1;
				const sent = await safeReply(message, {
					content: chunks[i],
					...(isLast ? attachOptions : {}),
				});
				if (!sent) break;
			}
		} else {
			await safeReply(message, { content: replyText, ...attachOptions });
		}
	} catch (error) {
		console.error(`[汎用モード] Bot ${botId} のメッセージ処理エラー:`, error);
		await safeReply(
			message,
			"申し訳ございません、処理中にエラーが発生しました 😢\nしばらくしてからもう一度お試しください。",
		);
	} finally {
		// どの経路（早期return・正常終了・例外）で抜けても「入力中...」維持タイマーを必ず止める。
		// 特に本文なしメンション（!fullText.trim()）の early return でタイマーが残り続け、
		// 「ずっと入力中」になる不具合を防ぐ。
		if (typingInterval) {
			clearInterval(typingInterval);
			typingInterval = null;
		}
		setBotStatus(botClient, "idle");
	}
}

// ─── 二重応答防止: メッセージ単位の冪等ガード（防御的措置） ──────────────────
// startCustomBot の直列化（startInFlight）で Client のリークは防いでいるが、
// それでも何らかの理由で同一 Discord identity（= 同一 bot user id）の Client が
// プロセス内に複数存在した場合に備え、1つの Discord メッセージへの処理を1回に保つ。
// キーは「bot user id : message id」。別Botを同時メンションした場合は user id が
// 異なるため、それぞれが正しく応答する（取りこぼさない）。
const recentlyHandledMessages = new Map<string, number>();
const HANDLED_MESSAGE_TTL_MS = 60_000;

/** 同一メッセージの初回処理なら true。既に処理済みなら false（= 応答をスキップすべき）。 */
function claimMessageOnce(botUserId: string, messageId: string): boolean {
	const now = Date.now();
	// 期限切れエントリの遅延掃除（メモリ肥大防止。低頻度で十分）
	if (recentlyHandledMessages.size > 2000) {
		for (const [k, exp] of recentlyHandledMessages) {
			if (exp <= now) recentlyHandledMessages.delete(k);
		}
	}
	const key = `${botUserId}:${messageId}`;
	const exp = recentlyHandledMessages.get(key);
	if (exp && exp > now) return false; // 既に同一identityで処理済み
	recentlyHandledMessages.set(key, now + HANDLED_MESSAGE_TTL_MS);
	return true;
}

export function setupMessageListener(botClient: Client, botId?: string) {
	botClient.on("messageCreate", async (message: Message) => {
		// Bot自身のメッセージは無視
		if (message.author.bot) return;

		// クライアントが利用可能でない（destroy直後・再起動中など）場合は処理しない。
		// この状態でREST送信すると "Expected token to be set" で失敗する
		if (!botClient.isReady() || !botClient.token) return;

		// 同一メッセージへの二重処理を防ぐ（同一identityのClientが複数存在しても応答は1回）。
		// 秘書フロー・汎用モードフローの分岐より前に行い、両経路を一括でガードする。
		if (botClient.user && !claimMessageOnce(botClient.user.id, message.id))
			return;

		// 汎用モード（MCPアシスタント）のBotはギルド常駐の専用フローで処理する（要件 §4.3）。
		// 秘書系の登録ユーザー・共有チェックは適用しない（利用メンバー制 §4.3.3）
		if (botId && isGuildAssistantBot(botId)) {
			await handleAssistantMessage(botClient, botId, message);
			return;
		}

		// 特定Bot専用のカスタムクライアントの場合、送信者がそのオーナーまたは共有ユーザーでなければ無視する
		if (botId) {
			const botRecord = getBotById(botId);
			if (!botRecord) return;
			if (message.author.id !== botRecord.user_id) {
				// 共有ユーザー（active）にも応答を許可する（§5.2）
				const accessibleBots = listBotsForUser(message.author.id);
				if (!accessibleBots.some((b) => b.id === botId)) return;
			}
		}

		// 登録ユーザーからのメッセージのみ応答（§5.4）
		if (!isRegisteredUser(message.author.id)) return;

		// 以前はユーザーが秘書型の独自Botを起動している場合にデフォルト（早瀬ユウカ）の応答を
		// 黙殺していたが、デフォルトと独自秘書Botを「同時起動・使い分け」できるようにするため撤廃。
		// 各Botは別々のDiscordアカウントであり、DMは別チャンネル・ギルドはメンション/返信で
		// 宛先が一意に決まるため、両方が同じメッセージへ二重応答することはない。

		// 処理対象のBot ID（カスタムの場合は botId、デフォルトの場合は system_default）
		const resolvedBotId = botId || "system_default";
		const userId = message.author.id;

		let isReplyToBot = false;
		let referencedMsg: Message | null = null;

		// 返信先メッセージの取得
		if (message.reference?.messageId) {
			try {
				referencedMsg = await message.channel.messages.fetch(
					message.reference.messageId,
				);
				if (referencedMsg?.author.id === botClient.user?.id) {
					isReplyToBot = true;
				}
			} catch (err) {
				console.error("返信先メッセージの取得に失敗しました:", err);
			}
		}

		// メンションされたかどうかチェック
		const isMentioned = message.mentions.has(botClient.user!);
		// DMかどうか
		const isDM = !message.guild;

		// メンションもDMも、ボットへの返信でもなければ無視
		if (!isMentioned && !isDM && !isReplyToBot) return;

		// 「入力中...」を維持するためのタイマー
		let typingInterval: NodeJS.Timeout | null = null;

		try {
			// 「入力中...」を表示し、処理が終わるまで5秒ごとに維持する
			if (
				"sendTyping" in message.channel &&
				typeof (message.channel as any).sendTyping === "function"
			) {
				const channel = message.channel as any;
				await channel
					.sendTyping()
					.catch((err: unknown) => console.error("sendTyping error:", err));
				typingInterval = setInterval(() => {
					channel
						.sendTyping()
						.catch((err: unknown) => console.error("sendTyping error:", err));
				}, 5000);
			}

			// メンションテキストを除去してクリーンなメッセージを取得
			const text = message.content.replace(/<@!?\d+>/g, "").trim();

			// 返信先メッセージのテキストをコンテキストプレフィックスとして構築
			// （DBに記録がないメッセージへの返信もカバーする。記録がある場合の完全なチェーン解決は
			//   processMessage 内の resolveReplyChain が行う §3.1.4）
			let contextPrefix = "";
			if (referencedMsg) {
				const authorName =
					referencedMsg.author.id === botClient.user?.id
						? "あなた"
						: referencedMsg.author.username;
				const cleanRefText = referencedMsg.content
					.replace(/<@!?\d+>/g, "")
					.trim();
				if (cleanRefText) {
					contextPrefix = `[返信先メッセージ (${authorName}): "${cleanRefText}"]\n`;
				}
			}

			// クリーンな入力テキスト
			const fullText = contextPrefix + text;

			// 添付ファイルのチェック（現在のメッセージ、または返信先メッセージ）
			let imageAttachment = message.attachments.find((a) =>
				a.contentType?.startsWith("image/"),
			);
			if (!imageAttachment && referencedMsg) {
				imageAttachment = referencedMsg.attachments.find((a) =>
					a.contentType?.startsWith("image/"),
				);
			}

			// 音声添付（§3.14: ボイスメッセージ・音声ファイルの文字起こし）
			const audioAttachment = message.attachments.find((a) => {
				const ct = (a.contentType || "").split(";")[0].trim().toLowerCase();
				return SUPPORTED_AUDIO_TYPES.includes(ct) || ct.startsWith("audio/");
			});

			const statusCallback = (status: "thinking" | "writing" | "idle") => {
				setBotStatus(botClient, status);
			};

			// 重い処理の非同期化ハンドル（Goal 2）。
			// - onInterim: 実行時に重いと判明した際の一時応答。「入力中…」を止めてから即返信する。
			// - deliverFinal: 事前予測で非同期化したターンの最終結果を、完了後に同チャンネルへ送る。
			const asyncDelivery: TurnAsyncDelivery = {
				onInterim: async (interimText: string) => {
					if (typingInterval) {
						clearInterval(typingInterval);
						typingInterval = null;
					}
					await safeReply(message, {
						content: toDiscordMarkdown(interimText),
					});
				},
				deliverFinal: async (payload) => {
					const target = isDM
						? ({ type: "dm" } as const)
						: ({ type: "channel", id: message.channelId } as const);
					const ok = await sendToUser(
						userId,
						{
							content: payload.content,
							embeds: payload.embeds,
							files: payload.files,
						},
						target,
						resolvedBotId,
					);
					// 同チャンネル送信に失敗した場合は DM へフォールバックして取りこぼしを防ぐ。
					if (!ok && !isDM) {
						await sendToUser(
							userId,
							{
								content: payload.content,
								embeds: payload.embeds,
								files: payload.files,
							},
							{ type: "dm" },
							resolvedBotId,
						);
					}
				},
			};

			let responseText: string;
			let responseEmbeds: import("discord.js").EmbedBuilder[] = [];
			let responseFiles: { attachment: Buffer; name: string }[] = [];

			if (audioAttachment) {
				console.log(
					`🎤 音声受信: ${audioAttachment.name} from ${message.author.tag}`,
				);

				const audioResponse = await fetch(audioAttachment.url);
				const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
				const audioBase64 = audioBuffer.toString("base64");
				const mimeType = (audioAttachment.contentType || "audio/ogg")
					.split(";")[0]
					.trim();

				const instruction =
					fullText.trim() ||
					"（音声メッセージを受信しました。内容を正確に文字起こしし、プレビューを提示してください。タスク依頼が含まれる場合はToDoへの変換を提案してください。）";

				const chatMessage: ChatMessage = {
					text: instruction,
					audioData: { data: audioBase64, mimeType },
					discordMsgId: message.id,
					replyToMsgId: message.reference?.messageId ?? undefined,
				};
				const result = await processMessage(
					resolvedBotId,
					userId,
					chatMessage,
					statusCallback,
					asyncDelivery,
				);
				responseText = result.text;
				responseEmbeds = result.embeds;
				responseFiles = result.files;
			} else if (imageAttachment) {
				console.log(
					`📷 画像受信 (返信先含む): ${imageAttachment.name} from ${message.author.tag}`,
				);

				const imageResponse = await fetch(imageAttachment.url);
				const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
				const imageBase64 = imageBuffer.toString("base64");
				const mimeType = imageAttachment.contentType || "image/jpeg";

				const result = await parseReceipt(
					resolvedBotId,
					userId,
					imageBase64,
					mimeType,
					text || undefined,
					statusCallback,
					asyncDelivery,
				);
				responseText = result.text;
				responseEmbeds = result.embeds;
				responseFiles = result.files;
			} else if (fullText.trim()) {
				const chatMessage: ChatMessage = {
					text: fullText,
					discordMsgId: message.id,
					replyToMsgId: message.reference?.messageId ?? undefined,
				};
				const result = await processMessage(
					resolvedBotId,
					userId,
					chatMessage,
					statusCallback,
					asyncDelivery,
				);
				responseText = result.text;
				responseEmbeds = result.embeds;
				responseFiles = result.files;
			} else {
				responseText =
					"何かお手伝いできることはありますか？ 📋\n\nタスク管理、予定管理、家計管理、ブラウザ操作ができますよ！";
			}

			// 応答が完了したため、タイマーをクリア
			if (typingInterval) {
				clearInterval(typingInterval);
				typingInterval = null;
			}

			// Discord の文字数制限 (2000文字) に対応しつつEmbed・ファイルを添付
			const attachOptions = {
				...(responseEmbeds.length > 0 ? { embeds: responseEmbeds } : {}),
				...(responseFiles.length > 0
					? {
							files: responseFiles.map((f) => ({
								attachment: f.attachment,
								name: f.name,
							})),
						}
					: {}),
			};

			// Discord非対応Markdownを互換表現へ変換（分割前の全文に適用）
			const replyText = toDiscordMarkdown(responseText);

			if (replyText.length > 2000) {
				const chunks = splitMessage(replyText, 2000);
				for (let i = 0; i < chunks.length; i++) {
					const isLast = i === chunks.length - 1;
					const sent = await safeReply(message, {
						content: chunks[i],
						...(isLast ? attachOptions : {}),
					});
					if (!sent) break; // 送信不能（トークン喪失等）なら以降のチャンクは諦める
				}
			} else {
				await safeReply(message, { content: replyText, ...attachOptions });
			}
		} catch (error) {
			console.error("メッセージ処理エラー:", error);
			// 返信自体が失敗してもプロセスを巻き込まない（safeReply内でcatch）
			await safeReply(
				message,
				"申し訳ございません、処理中にエラーが発生しました 😢\nしばらくしてからもう一度お試しください。",
			);
		} finally {
			// どの経路で抜けても「入力中...」維持タイマーを必ず止める（タイマー残留＝ずっと入力中を防ぐ）。
			if (typingInterval) {
				clearInterval(typingInterval);
				typingInterval = null;
			}
			setBotStatus(botClient, "idle");
		}
	});
}

/**
 * 長いメッセージを指定文字数で分割
 */
function splitMessage(text: string, maxLength: number): string[] {
	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		let splitPoint = remaining.lastIndexOf("\n", maxLength);
		if (splitPoint === -1 || splitPoint < maxLength / 2) {
			splitPoint = maxLength;
		}

		chunks.push(remaining.substring(0, splitPoint));
		remaining = remaining.substring(splitPoint).trimStart();
	}

	return chunks;
}

/**
 * BotのデクリプトされたDiscordトークンを取得する
 */
function getDecryptedDiscordToken(botId: string): string | null {
	const config = getBotDiscordConfig(botId);
	if (
		!config ||
		!config.tokenEncrypted ||
		!config.tokenIv ||
		!config.tokenTag
	) {
		return null;
	}
	try {
		return decryptText(config.tokenEncrypted, config.tokenIv, config.tokenTag);
	} catch (err) {
		console.error(
			`[Discord Bot] [Bot: ${botId}] トークンの復号に失敗しました:`,
			err,
		);
		return null;
	}
}

/**
 * Bot ID 単位で進行中の起動処理を保持し、同時起動を直列化するためのガード。
 * startCustomBot は内部で `await login` を挟むため、起動連打や restart との競合で
 * 複数の呼び出しがいずれも「既存クライアント無し」と誤判定し、destroy されない
 * Client が Gateway に接続したまま生き残る（= 同一メッセージへ二重応答する）ことがあった。
 */
const startInFlight = new Map<string, Promise<boolean>>();

/**
 * Bot IDに紐づく独自のDiscord Botクライアントを起動する。
 * 同一Botの起動が進行中の場合は、新しいClientを作らずその起動に合流する（冪等・リーク防止）。
 */
export async function startCustomBot(botId: string): Promise<boolean> {
	const inFlight = startInFlight.get(botId);
	if (inFlight) return inFlight;

	// startCustomBotInner() は最初の await まで同期実行されるため、
	// 制御が一旦イベントループへ戻る前に in-flight 登録が完了する（後続の同時呼び出しが必ず合流できる）。
	const promise = startCustomBotInner(botId);
	startInFlight.set(botId, promise);
	try {
		return await promise;
	} finally {
		// 自分が登録したエントリのみ削除する（不要だが将来の安全のためのガード）。
		if (startInFlight.get(botId) === promise) startInFlight.delete(botId);
	}
}

async function startCustomBotInner(botId: string): Promise<boolean> {
	// 停止処分中のBotは起動しない（Admin管理 §5.3.2）
	if (isBotSuspended(botId)) {
		console.log(`⛔ Bot ${botId} は停止処分中のため起動しません。`);
		return false;
	}

	const token = getDecryptedDiscordToken(botId);
	if (!token) return false;

	// 既存の接続があれば一度破棄
	const existing = customClients.get(botId);
	if (existing) {
		try {
			existing.destroy();
		} catch {}
		customClients.delete(botId);
	}

	const customClient = new Client(DISCORD_CLIENT_OPTIONS);

	try {
		customClient.once(Events.ClientReady, (c) => {
			console.log(
				`✅ 独自Bot (Bot: ${botId}): ${c.user.tag} としてログインしました`,
			);
			setBotStatus(customClient, "idle");
			// Discordからプロフィールを同期
			try {
				const avatarUrl = c.user.displayAvatarURL();
				updateBotDiscordProfile(botId, c.user.username, avatarUrl, c.user.id);
				console.log(
					`[Discord Bot] 独自Bot (Bot: ${botId}) のプロフィールを同期しました: ${c.user.username}`,
				);
			} catch (err) {
				console.error(
					`[Discord Bot] 独自Bot (Bot: ${botId}) のプロフィールの同期に失敗しました:`,
					err,
				);
			}
		});

		// 'error' リスナー必須（プロセスクラッシュ防止）
		customClient.on(Events.Error, (err) => {
			console.error(
				`[Discord Bot] [Bot: ${botId}] クライアントでエラーが発生しました:`,
				err,
			);
		});
		customClient.on(Events.InteractionCreate, handleInteraction);
		setupMessageListener(customClient, botId);
		await customClient.login(token);
		customClients.set(botId, customClient);
		return true;
	} catch (err) {
		console.error(
			`[Discord Bot] [Bot: ${botId}] 独自Botの起動に失敗しました:`,
			err,
		);
		try {
			customClient.destroy();
		} catch {}
		return false;
	}
}

/**
 * Bot IDに紐づく独自のDiscord Botクライアントを停止・クローズする
 */
export function stopCustomBot(botId: string): void {
	const customClient = customClients.get(botId);
	if (customClient) {
		try {
			customClient.destroy();
			console.log(`🔌 独自Bot (Bot: ${botId}) を停止しました。`);
		} catch (err) {
			console.error(
				`[Discord Bot] [Bot: ${botId}] 独自Botの停止中にエラーが発生しました:`,
				err,
			);
		}
		customClients.delete(botId);
	}
}

export async function restartDefaultBot(token: string): Promise<boolean> {
	// discord.js v14 は destroy 済み Client の再ログインをサポートしない
	// （ready にはなるがイベントが配送されない状態になり得る）ため、
	// 同一インスタンスの再利用ではなく必ず新しい Client へ差し替える。
	try {
		await client.destroy();
		console.log("🔌 デフォルトBotを一旦停止しました。再起動します...");
	} catch {}

	const newClient = new Client(DISCORD_CLIENT_OPTIONS);
	attachDefaultClientHandlers(newClient);

	try {
		await newClient.login(token);
		client = newClient; // ライブバインディング経由で notifier 等の参照側にも反映される
		console.log("✅ デフォルトBotが新しいトークンでログイン成功しました。");
		return true;
	} catch (err) {
		console.error("❌ デフォルトBotのログインに失敗しました:", err);
		try {
			await newClient.destroy();
		} catch {}
		return false;
	}
}

export async function startBot(): Promise<void> {
	// 1. デフォルトBotをログイン（リスナーは attachDefaultClientHandlers で登録済み）
	const token = getDecryptedDiscordToken("system_default");
	if (token) {
		try {
			await client.login(token);
		} catch (err) {
			console.error(
				"❌ デフォルトBot (system_default) のログインに失敗しました:",
				err,
			);
		}
	} else {
		console.log(
			"ℹ️ デフォルトBot (system_default) のトークンが登録されていません。初期セットアップを完了してください。",
		);
	}

	// 2. 登録済み全Botをチェックし、独自Discord Tokenが設定されている場合はそれぞれBotを起動。
	//    オーナーが手動停止した（stopped=1）Botは自動起動の対象外＝再起動後も停止状態を維持する。
	const bots = listAllBots();
	for (const bot of bots) {
		if (bot.id === "system_default") continue;
		if (bot.stopped === 1) {
			console.log(
				`⏸️ Bot ${bot.id} はオーナーにより停止中のため自動起動しません。`,
			);
			continue;
		}
		await startCustomBot(bot.id).catch((err) => {
			console.error(
				`[Discord Bot] Bot ${bot.id} の独自Bot起動中に例外発生:`,
				err,
			);
		});
	}
}

export function stopBot(): void {
	if (profileSyncTimer) {
		clearInterval(profileSyncTimer);
		profileSyncTimer = null;
	}

	// デフォルトBot停止
	client.destroy();

	// 独自Bot群の停止
	for (const [botId, customClient] of customClients.entries()) {
		try {
			customClient.destroy();
			console.log(`🔌 独自Bot (Bot: ${botId}) を停止しました。`);
		} catch {}
	}
	customClients.clear();
}
