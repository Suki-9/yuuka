import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  Events,
  type Message,
} from "discord.js";
import { processMessage, type ChatMessage } from "./gemini.js";
import { parseReceipt } from "./services/receiptParser.js";
import { startReminderService, stopReminderService } from "./services/reminderService.js";
import { isRegisteredUser } from "./db/userRepo.js";
import { getBotById, getBotDiscordConfig, listAllBotIds, listBotsForUser } from "./db/botRepo.js";
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

client.once(Events.ClientReady, (c) => {
  console.log(`✅ デフォルトBot: ${c.user.tag} としてログインしました (clientReady)`);
  setBotStatus(client, "idle");
  // リマインダーサービスを開始
  startReminderService();
});

/**
 * 指定したBotクライアントにメッセージハンドラーを設定する
 */
export function setupMessageListener(botClient: Client, botId?: string) {
  botClient.on("messageCreate", async (message: Message) => {
    // Bot自身のメッセージは無視
    if (message.author.bot) return;

    // 特定Bot専用のカスタムクライアントの場合、送信者がそのオーナーでなければ完全に無視する
    if (botId) {
      const botRecord = getBotById(botId);
      if (!botRecord || message.author.id !== botRecord.user_id) return;
    }

    // デフォルトクライアントの場合、登録ユーザーからのメッセージのみ応答
    if (!botId && !isRegisteredUser(message.author.id)) return;

    // 登録ユーザーが独自のBotを有効に起動している場合は、デフォルトクライアントは応答をスキップする
    if (!botId) {
      const authorBots = listBotsForUser(message.author.id);
      const hasActiveCustomBot = authorBots.some(b => {
        if (b.id === "system_default") return false;
        const custom = customClients.get(b.id);
        return custom && custom.readyAt;
      });
      if (hasActiveCustomBot) {
        return;
      }
    }

    // 処理対象のBot ID（カスタムの場合は botId、デフォルトの場合は system_default）
    const resolvedBotId = botId || "system_default";

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

        response = await parseReceipt(resolvedBotId, imageBase64, mimeType, text || undefined, statusCallback);
      } else if (fullText.trim()) {
        const chatMessage: ChatMessage = { text: fullText };
        response = await processMessage(resolvedBotId, chatMessage, statusCallback);
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
    customClient.once(Events.ClientReady, (c) => {
      console.log(`✅ 独自Bot (Bot: ${botId}): ${c.user.tag} としてログインしました`);
      setBotStatus(customClient, "idle");
    });

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
    client.destroy();
    console.log("🔌 デフォルトBotを一旦停止しました。再起動します...");
  } catch {}

  try {
    // 新しいトークンでログイン
    setupMessageListener(client);
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
  stopReminderService();
  
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
