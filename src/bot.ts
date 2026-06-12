import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
  type Message,
} from "discord.js";
import { processMessage, type ChatMessage } from "./gemini.js";
import { parseReceipt } from "./services/receiptParser.js";
import { isRegisteredUser } from "./db/userRepo.js";
import {
  getBotById,
  getBotDiscordConfig,
  listAllBotIds,
  listBotsForUser,
  updateBotDiscordProfile,
  isBotSuspended,
  acceptShareInvite,
  revokeShare,
  getShareById,
} from "./db/botRepo.js";
import { importPersona, getPersonaById } from "./db/personaRepo.js";
import { decryptText } from "./utils/crypto.js";

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
  "audio/ogg", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/flac",
];

// デフォルト（共有）クライアント
export const client = new Client(DISCORD_CLIENT_OPTIONS);

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

export function setBotStatus(botClient: Client, status: "thinking" | "writing" | "idle") {
  if (!botClient.user) return;
  try {
    if (status === "thinking") {
      botClient.user.setPresence({
        activities: [{
          name: "custom",
          type: ActivityType.Custom,
          state: "考え中...",
        }],
        status: "dnd",
      });
    } else if (status === "writing") {
      botClient.user.setPresence({
        activities: [{
          name: "custom",
          type: ActivityType.Custom,
          state: "書き込み中...",
        }],
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
      updateBotDiscordProfile("system_default", client.user.username, client.user.displayAvatarURL());
    }
    for (const [botId, customClient] of customClients.entries()) {
      if (customClient.user && customClient.readyAt) {
        updateBotDiscordProfile(botId, customClient.user.username, customClient.user.displayAvatarURL());
      }
    }
  } catch (err) {
    console.error("[Discord Bot] プロフィール定期同期に失敗しました:", err);
  }
}

function startProfileSyncTimer(): void {
  if (profileSyncTimer) return;
  profileSyncTimer = setInterval(() => {
    syncAllBotProfiles();
  }, 60 * 60 * 1000); // 1時間ごと
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
  recommendedPersonaName?: string
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
        .setStyle(ButtonStyle.Secondary)
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
    console.error(`[Discord Bot] 共有招待DMの送信に失敗しました (user: ${sharedUserId}):`, err);
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
        await interaction.reply({ content: "この招待はあなた宛ではないか、既に無効です。", ephemeral: true });
        return;
      }
      if (share.status !== "pending") {
        await interaction.reply({ content: "この招待は既に処理済みです。", ephemeral: true });
        return;
      }

      if (action === "share_decline") {
        revokeShare(share.bot_id, share.shared_user_id);
        await interaction.update({ content: "招待を辞退しました。", components: [] });
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
              .setStyle(ButtonStyle.Primary)
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
        await interaction.reply({ content: "先にユーザー登録を完了してください。", ephemeral: true });
        return;
      }
      const result = importPersona(interaction.user.id, parseInt(idStr, 10));
      if (result) {
        await interaction.update({
          content: `✅ ペルソナをインポートしました。管理画面の「ペルソナ」から適用できます。`,
          components: [],
        });
      } else {
        await interaction.update({ content: "ペルソナのインポートに失敗しました（非公開化された可能性があります）。", components: [] });
      }
      return;
    }
  } catch (err) {
    console.error("[Discord Bot] インタラクション処理エラー:", err);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "処理中にエラーが発生しました。", ephemeral: true });
      }
    } catch {}
  }
}

// REST/Gateway起因のエラーでプロセスが落ちないようにする。
// discord.js の Client は 'error' リスナーが無いと、非同期リスナー内の例外が
// 'error' イベントとして emit された際に Node プロセスごとクラッシュする。
client.on(Events.Error, (err) => {
  console.error("[Discord Bot] デフォルトクライアントでエラーが発生しました:", err);
});

// [Debug] 無反応調査用: ゲートウェイから MESSAGE_CREATE が届いているかを
// messageCreate リスナーとは独立に確認する（原因特定後に削除する）
client.on(Events.Raw, (packet: { t?: string }) => {
  if (packet?.t === "MESSAGE_CREATE") {
    console.log("[Debug] Gateway: MESSAGE_CREATE dispatch を受信");
  }
});

client.on(Events.ClientReady, (c) => {
  console.log(`✅ デフォルトBot: ${c.user.tag} としてログインしました (clientReady)`);
  setBotStatus(client, "idle");

  // Discordからプロフィールを同期（起動時 §4.3.2）
  try {
    const avatarUrl = c.user.displayAvatarURL();
    updateBotDiscordProfile("system_default", c.user.username, avatarUrl);
    console.log(`[Discord Bot] デフォルトBotのプロフィールを同期しました: ${c.user.username}`);
  } catch (err) {
    console.error("[Discord Bot] デフォルトBotのプロフィールの同期に失敗しました:", err);
  }

  startProfileSyncTimer();
});

client.on(Events.InteractionCreate, handleInteraction);

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
  options: Parameters<Message["reply"]>[0]
): Promise<boolean> {
  try {
    await message.reply(options);
    return true;
  } catch (err) {
    console.error("[Discord Bot] 返信の送信に失敗しました:", err);
    return false;
  }
}

export function setupMessageListener(botClient: Client, botId?: string) {
  botClient.on("messageCreate", async (message: Message) => {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;

    // [Debug] 無反応調査用の受信トレース（原因特定後に削除する）
    console.log(
      `[Debug] messageCreate: author=${message.author.id} ` +
        `place=${message.guild ? `guild:${message.guild.id}` : "DM"} ` +
        `ready=${botClient.isReady()} token=${!!botClient.token} contentLen=${message.content.length}`
    );

    // クライアントが利用可能でない（destroy直後・再起動中など）場合は処理しない。
    // この状態でREST送信すると "Expected token to be set" で失敗する
    if (!botClient.isReady() || !botClient.token) {
      console.log("[Debug] → 早期return: クライアント未準備（isReady/token）");
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
    if (!isRegisteredUser(message.author.id)) {
      console.log(`[Debug] → 早期return: 未登録ユーザー (${message.author.id})`);
      return;
    }

    // 登録ユーザーが独自のBotを有効に起動している場合は、デフォルトクライアントは応答をスキップする
    if (!botId) {
      const authorBots = listBotsForUser(message.author.id);
      const hasActiveCustomBot = authorBots.some(b => {
        if (b.id === "system_default") return false;
        const custom = customClients.get(b.id);
        return custom && custom.readyAt;
      });
      if (hasActiveCustomBot) {
        console.log("[Debug] → 早期return: 独自Bot稼働中のためデフォルトBotはスキップ");
        return;
      }
    }

    // 処理対象のBot ID（カスタムの場合は botId、デフォルトの場合は system_default）
    const resolvedBotId = botId || "system_default";
    const userId = message.author.id;

    let isReplyToBot = false;
    let referencedMsg: Message | null = null;

    // 返信先メッセージの取得
    if (message.reference?.messageId) {
      try {
        referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
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
    if (!isMentioned && !isDM && !isReplyToBot) {
      console.log("[Debug] → 早期return: メンション/DM/Bot宛返信のいずれでもない");
      return;
    }

    // 「入力中...」を維持するためのタイマー
    let typingInterval: NodeJS.Timeout | null = null;

    try {
      // 「入力中...」を表示し、処理が終わるまで5秒ごとに維持する
      if ("sendTyping" in message.channel && typeof (message.channel as any).sendTyping === "function") {
        const channel = message.channel as any;
        await channel.sendTyping().catch((err: unknown) => console.error("sendTyping error:", err));
        typingInterval = setInterval(() => {
          channel.sendTyping().catch((err: unknown) => console.error("sendTyping error:", err));
        }, 5000);
      }

      // メンションテキストを除去してクリーンなメッセージを取得
      let text = message.content
        .replace(/<@!?\d+>/g, "")
        .trim();

      // 返信先メッセージのテキストをコンテキストプレフィックスとして構築
      // （DBに記録がないメッセージへの返信もカバーする。記録がある場合の完全なチェーン解決は
      //   processMessage 内の resolveReplyChain が行う §3.1.4）
      let contextPrefix = "";
      if (referencedMsg) {
        const authorName = referencedMsg.author.id === botClient.user?.id ? "あなた" : referencedMsg.author.username;
        const cleanRefText = referencedMsg.content.replace(/<@!?\d+>/g, "").trim();
        if (cleanRefText) {
          contextPrefix = `[返信先メッセージ (${authorName}): "${cleanRefText}"]\n`;
        }
      }

      // クリーンな入力テキスト
      const fullText = contextPrefix + text;

      // 添付ファイルのチェック（現在のメッセージ、または返信先メッセージ）
      let imageAttachment = message.attachments.find((a) =>
        a.contentType?.startsWith("image/")
      );
      if (!imageAttachment && referencedMsg) {
        imageAttachment = referencedMsg.attachments.find((a) =>
          a.contentType?.startsWith("image/")
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

      let responseText: string;
      let responseEmbeds: import("discord.js").EmbedBuilder[] = [];
      let responseFiles: { attachment: Buffer; name: string }[] = [];

      if (audioAttachment) {
        console.log(`🎤 音声受信: ${audioAttachment.name} from ${message.author.tag}`);

        const audioResponse = await fetch(audioAttachment.url);
        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
        const audioBase64 = audioBuffer.toString("base64");
        const mimeType = (audioAttachment.contentType || "audio/ogg").split(";")[0].trim();

        const instruction =
          fullText.trim() ||
          "（音声メッセージを受信しました。内容を正確に文字起こしし、プレビューを提示してください。タスク依頼が含まれる場合はToDoへの変換を提案してください。）";

        const chatMessage: ChatMessage = {
          text: instruction,
          audioData: { data: audioBase64, mimeType },
          discordMsgId: message.id,
          replyToMsgId: message.reference?.messageId ?? undefined,
        };
        const result = await processMessage(resolvedBotId, userId, chatMessage, statusCallback);
        responseText = result.text;
        responseEmbeds = result.embeds;
        responseFiles = result.files;
      } else if (imageAttachment) {
        console.log(`📷 画像受信 (返信先含む): ${imageAttachment.name} from ${message.author.tag}`);

        const imageResponse = await fetch(imageAttachment.url);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const imageBase64 = imageBuffer.toString("base64");
        const mimeType = imageAttachment.contentType || "image/jpeg";

        const result = await parseReceipt(resolvedBotId, userId, imageBase64, mimeType, text || undefined, statusCallback);
        responseText = result.text;
        responseEmbeds = result.embeds;
        responseFiles = result.files;
      } else if (fullText.trim()) {
        const chatMessage: ChatMessage = {
          text: fullText,
          discordMsgId: message.id,
          replyToMsgId: message.reference?.messageId ?? undefined,
        };
        const result = await processMessage(resolvedBotId, userId, chatMessage, statusCallback);
        responseText = result.text;
        responseEmbeds = result.embeds;
        responseFiles = result.files;
      } else {
        responseText = "何かお手伝いできることはありますか？ 📋\n\nタスク管理、予定管理、家計管理、ブラウザ操作ができますよ！";
      }

      // 応答が完了したため、タイマーをクリア
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }

      // Discord の文字数制限 (2000文字) に対応しつつEmbed・ファイルを添付
      const attachOptions = {
        ...(responseEmbeds.length > 0 ? { embeds: responseEmbeds } : {}),
        ...(responseFiles.length > 0 ? { files: responseFiles.map(f => ({ attachment: f.attachment, name: f.name })) } : {}),
      };

      if (responseText.length > 2000) {
        const chunks = splitMessage(responseText, 2000);
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          const sent = await safeReply(message, {
            content: chunks[i],
            ...(isLast ? attachOptions : {}),
          });
          if (!sent) break; // 送信不能（トークン喪失等）なら以降のチャンクは諦める
        }
      } else {
        await safeReply(message, { content: responseText, ...attachOptions });
      }
    } catch (error) {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      console.error("メッセージ処理エラー:", error);
      // 返信自体が失敗してもプロセスを巻き込まない（safeReply内でcatch）
      await safeReply(
        message,
        "申し訳ございません、処理中にエラーが発生しました 😢\nしばらくしてからもう一度お試しください。"
      );
    } finally {
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
  if (!config || !config.tokenEncrypted || !config.tokenIv || !config.tokenTag) {
    return null;
  }
  try {
    return decryptText(config.tokenEncrypted, config.tokenIv, config.tokenTag);
  } catch (err) {
    console.error(`[Discord Bot] [Bot: ${botId}] トークンの復号に失敗しました:`, err);
    return null;
  }
}

/**
 * Bot IDに紐づく独自のDiscord Botクライアントを起動する
 */
export async function startCustomBot(botId: string): Promise<boolean> {
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
      console.log(`✅ 独自Bot (Bot: ${botId}): ${c.user.tag} としてログインしました`);
      setBotStatus(customClient, "idle");
      // Discordからプロフィールを同期
      try {
        const avatarUrl = c.user.displayAvatarURL();
        updateBotDiscordProfile(botId, c.user.username, avatarUrl);
        console.log(`[Discord Bot] 独自Bot (Bot: ${botId}) のプロフィールを同期しました: ${c.user.username}`);
      } catch (err) {
        console.error(`[Discord Bot] 独自Bot (Bot: ${botId}) のプロフィールの同期に失敗しました:`, err);
      }
    });

    // 'error' リスナー必須（プロセスクラッシュ防止）
    customClient.on(Events.Error, (err) => {
      console.error(`[Discord Bot] [Bot: ${botId}] クライアントでエラーが発生しました:`, err);
    });
    customClient.on(Events.InteractionCreate, handleInteraction);
    setupMessageListener(customClient, botId);
    await customClient.login(token);
    customClients.set(botId, customClient);
    return true;
  } catch (err) {
    console.error(`[Discord Bot] [Bot: ${botId}] 独自Botの起動に失敗しました:`, err);
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
      console.error(`[Discord Bot] [Bot: ${botId}] 独自Botの停止中にエラーが発生しました:`, err);
    }
    customClients.delete(botId);
  }
}


export async function restartDefaultBot(token: string): Promise<boolean> {
  try {
    // destroy の完了を待ってから再ログインする（処理中メッセージとのレース窓を最小化）
    await client.destroy();
    console.log("🔌 デフォルトBotを一旦停止しました。再起動します...");
  } catch {}

  try {
    // 既存のリスナーを除去してから再登録（二重登録防止）
    client.removeAllListeners("messageCreate");
    client.removeAllListeners(Events.ClientReady);
    client.removeAllListeners(Events.InteractionCreate);
    client.removeAllListeners(Events.Error);
    setupMessageListener(client);
    client.on(Events.InteractionCreate, handleInteraction);
    client.on(Events.Error, (err) => {
      console.error("[Discord Bot] デフォルトクライアントでエラーが発生しました:", err);
    });

    // Readyイベントの再登録
    client.on(Events.ClientReady, (c) => {
      console.log(`✅ デフォルトBot: ${c.user.tag} としてログインしました (clientReady)`);
      setBotStatus(client, "idle");
      try {
        const avatarUrl = c.user.displayAvatarURL();
        updateBotDiscordProfile("system_default", c.user.username, avatarUrl);
        console.log(`[Discord Bot] デフォルトBotのプロフィールを同期しました: ${c.user.username}`);
      } catch (err) {
        console.error("[Discord Bot] デフォルトBotのプロフィールの同期に失敗しました:", err);
      }
    });

    await client.login(token);
    console.log("✅ デフォルトBotが新しいトークンでログイン成功しました。");
    return true;
  } catch (err) {
    console.error("❌ デフォルトBotのログインに失敗しました:", err);
    return false;
  }
}

export async function startBot(): Promise<void> {
  // 1. デフォルトBotをログイン
  setupMessageListener(client);
  const token = getDecryptedDiscordToken("system_default");
  if (token) {
    try {
      await client.login(token);
    } catch (err) {
      console.error("❌ デフォルトBot (system_default) のログインに失敗しました:", err);
    }
  } else {
    console.log("ℹ️ デフォルトBot (system_default) のトークンが登録されていません。初期セットアップを完了してください。");
  }

  // 2. 登録済み全Botをチェックし、独自Discord Tokenが設定されている場合はそれぞれBotを起動
  const botIds = listAllBotIds();
  for (const botId of botIds) {
    if (botId === "system_default") continue;
    await startCustomBot(botId).catch((err) => {
      console.error(`[Discord Bot] Bot ${botId} の独自Bot起動中に例外発生:`, err);
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
