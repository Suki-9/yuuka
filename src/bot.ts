import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  type Message,
} from "discord.js";
import { config } from "./config.js";
import { processMessage, type ChatMessage } from "./gemini.js";
import { parseReceipt } from "./services/receiptParser.js";
import { startReminderService, stopReminderService } from "./services/reminderService.js";
import { isRegisteredUser, getUserDiscordBotConfig, listAllUserIds } from "./db/userRepo.js";
import { decryptText } from "./utils/crypto.js";

// デフォルト（共有）クライアント
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ユーザーごとのカスタムクライアント: Map<userId, Client>
export const customClients = new Map<string, Client>();

/**
 * ユーザーIDに応じた適切なBotクライアントを取得する
 * ユーザーが独自のDiscord Tokenを設定している場合はそれを優先し、無ければデフォルトクライアントを返す
 */
export function getBotClientForUser(userId: string): Client {
  const custom = customClients.get(userId);
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

client.once("ready", (c) => {
  console.log(`✅ デフォルトBot: ${c.user.tag} としてログインしました`);
  setBotStatus(client, "idle");
  // リマインダーサービスを開始
  startReminderService();
});

client.once("clientReady", (c) => {
  console.log(`✅ デフォルトBot: ${c.user.tag} としてログインしました (clientReady)`);
  setBotStatus(client, "idle");
  // リマインダーサービスを開始
  startReminderService();
});

/**
 * 指定したBotクライアントにメッセージハンドラーを設定する
 */
export function setupMessageListener(botClient: Client, ownerId?: string) {
  botClient.on("messageCreate", async (message: Message) => {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;

    // 特定ユーザー専用のカスタムクライアントの場合、送信者がそのオーナーでなければ完全に無視する
    if (ownerId && message.author.id !== ownerId) return;

    // デフォルトクライアントの場合、登録ユーザーからのメッセージのみ応答
    if (!ownerId && !isRegisteredUser(message.author.id)) return;

    // 登録ユーザーが独自のBotを有効に起動している場合は、デフォルトクライアントは応答をスキップする
    if (!ownerId && customClients.has(message.author.id)) {
      const customClient = customClients.get(message.author.id);
      if (customClient && customClient.readyAt) {
        return;
      }
    }

    // 処理対象のユーザーID（カスタムの場合はオーナー、デフォルトの場合はメッセージの送信者）
    const userId = ownerId || message.author.id;

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
    if (!isMentioned && !isDM && !isReplyToBot) return;

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
      let contextPrefix = "";
      if (referencedMsg) {
        const authorName = referencedMsg.author.id === botClient.user?.id ? "あなた" : referencedMsg.author.username;
        const cleanRefText = referencedMsg.content.replace(/<@!?\d+>/g, "").trim();
        contextPrefix = `[返信先メッセージ (${authorName}): "${cleanRefText}"]\n`;
      }

      // クリーンな入力テキスト
      const fullText = contextPrefix + text;

      // 画像添付があるかチェック（現在のメッセージ、または返信先メッセージ）
      let imageAttachment = message.attachments.find((a) =>
        a.contentType?.startsWith("image/")
      );
      if (!imageAttachment && referencedMsg) {
        imageAttachment = referencedMsg.attachments.find((a) =>
          a.contentType?.startsWith("image/")
        );
      }

      let response: string;
      const statusCallback = (status: "thinking" | "writing" | "idle") => {
        setBotStatus(botClient, status);
      };

      if (imageAttachment) {
        console.log(`📷 画像受信 (返信先含む): ${imageAttachment.name} from ${message.author.tag}`);

        const imageResponse = await fetch(imageAttachment.url);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const imageBase64 = imageBuffer.toString("base64");
        const mimeType = imageAttachment.contentType || "image/jpeg";

        response = await parseReceipt(userId, imageBase64, mimeType, text || undefined, statusCallback);
      } else if (fullText.trim()) {
        const chatMessage: ChatMessage = { text: fullText };
        response = await processMessage(userId, chatMessage, statusCallback);
      } else {
        response = "何かお手伝いできることはありますか？ 📋\n\nタスク管理、予定管理、家計管理ができますよ！";
      }

      // 応答が完了したため、タイマーをクリア
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }

      // Discord の文字数制限 (2000文字) に対応
      if (response.length > 2000) {
        const chunks = splitMessage(response, 2000);
        for (const chunk of chunks) {
          await message.reply(chunk);
        }
      } else {
        await message.reply(response);
      }
    } catch (error) {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      console.error("メッセージ処理エラー:", error);
      await message.reply(
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
 * ユーザー別のデクリプトされたDiscordトークンを取得する
 */
function getDecryptedDiscordToken(userId: string): string | null {
  const config = getUserDiscordBotConfig(userId);
  if (!config || !config.tokenEncrypted || !config.tokenIv || !config.tokenTag) {
    return null;
  }
  try {
    return decryptText(config.tokenEncrypted, config.tokenIv, config.tokenTag);
  } catch (err) {
    console.error(`[Discord Bot] [User: ${userId}] トークンの復号に失敗しました:`, err);
    return null;
  }
}

/**
 * ユーザーIDに紐づく独自のDiscord Botクライアントを起動する
 */
export async function startCustomBotForUser(userId: string): Promise<boolean> {
  const token = getDecryptedDiscordToken(userId);
  if (!token) return false;

  // 既存の接続があれば一度破棄
  const existing = customClients.get(userId);
  if (existing) {
    try {
      existing.destroy();
    } catch {}
    customClients.delete(userId);
  }

  const customClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  try {
    customClient.once("ready", (c) => {
      console.log(`✅ 独自Bot (ユーザー: ${userId}): ${c.user.tag} としてログインしました`);
      setBotStatus(customClient, "idle");
    });

    setupMessageListener(customClient, userId);
    await customClient.login(token);
    customClients.set(userId, customClient);
    return true;
  } catch (err) {
    console.error(`[Discord Bot] [User: ${userId}] 独自Botの起動に失敗しました:`, err);
    try {
      customClient.destroy();
    } catch {}
    return false;
  }
}

/**
 * ユーザーIDに紐づく独自のDiscord Botクライアントを停止・クローズする
 */
export function stopCustomBotForUser(userId: string): void {
  const customClient = customClients.get(userId);
  if (customClient) {
    try {
      customClient.destroy();
      console.log(`🔌 独自Bot (ユーザー: ${userId}) を停止しました。`);
    } catch (err) {
      console.error(`[Discord Bot] [User: ${userId}] 独自Botの停止中にエラーが発生しました:`, err);
    }
    customClients.delete(userId);
  }
}


export async function startBot(): Promise<void> {
  // 1. デフォルトBotをログイン
  setupMessageListener(client);
  await client.login(config.discordToken);

  // 2. 登録済み全ユーザーをチェックし、独自Discord Tokenが設定されている場合はそれぞれBotを起動
  const userIds = listAllUserIds();
  for (const userId of userIds) {
    await startCustomBotForUser(userId).catch((err) => {
      console.error(`[Discord Bot] ユーザー ${userId} の独自Bot起動中に例外発生:`, err);
    });
  }
}

export function stopBot(): void {
  stopReminderService();
  
  // デフォルトBot停止
  client.destroy();

  // 独自Bot群の停止
  for (const [userId, customClient] of customClients.entries()) {
    try {
      customClient.destroy();
      console.log(`🔌 独自Bot (ユーザー: ${userId}) を停止しました。`);
    } catch {}
  }
  customClients.clear();
}
