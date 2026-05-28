import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { config } from "./config.js";
import { processMessage, type ChatMessage } from "./gemini.js";
import { parseReceipt } from "./services/receiptParser.js";
import { startReminderService, stopReminderService } from "./services/reminderService.js";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once("clientReady", (c) => {
  console.log(`✅ ${c.user.tag} としてログインしました`);

  // リマインダーサービスを開始
  startReminderService(client);
});

client.on("messageCreate", async (message: Message) => {
  // Bot自身のメッセージは無視
  if (message.author.bot) return;

  let isReplyToBot = false;
  let referencedMsg: Message | null = null;

  // 返信先メッセージの取得
  if (message.reference?.messageId) {
    try {
      referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (referencedMsg?.author.id === client.user?.id) {
        isReplyToBot = true;
      }
    } catch (err) {
      console.error("返信先メッセージの取得に失敗しました:", err);
    }
  }

  // メンションされたかどうかチェック
  const isMentioned = message.mentions.has(client.user!);
  // DMかどうか
  const isDM = !message.guild;

  // メンションもDMも、ボットへの返信でもなければ無視
  if (!isMentioned && !isDM && !isReplyToBot) return;

  try {
    // 「入力中...」を表示
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    const userId = message.author.id;

    // メンションテキストを除去してクリーンなメッセージを取得
    let text = message.content
      .replace(/<@!?\d+>/g, "")
      .trim();

    // 返信先メッセージのテキストをコンテキストプレフィックスとして構築
    let contextPrefix = "";
    if (referencedMsg) {
      const authorName = referencedMsg.author.id === client.user?.id ? "あなた（ユウカ）" : referencedMsg.author.username;
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

    if (imageAttachment) {
      // 画像がある場合：レシート解析を試める
      console.log(`📷 画像受信 (返信先含む): ${imageAttachment.name} from ${message.author.tag}`);

      const imageResponse = await fetch(imageAttachment.url);
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      const imageBase64 = imageBuffer.toString("base64");
      const mimeType = imageAttachment.contentType || "image/jpeg";

      response = await parseReceipt(userId, imageBase64, mimeType, text || undefined);
    } else if (fullText.trim()) {
      // テキストのみ
      const chatMessage: ChatMessage = { text: fullText };
      response = await processMessage(userId, chatMessage);
    } else {
      response = "何かお手伝いできることはありますか？ 📋\n\nタスク管理、予定管理、家計管理ができますよ！";
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
    console.error("メッセージ処理エラー:", error);
    await message.reply(
      "申し訳ございません、処理中にエラーが発生しました 😢\nしばらくしてからもう一度お試しください。"
    );
  }
});

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

    // 改行で区切れるポイントを探す
    let splitPoint = remaining.lastIndexOf("\n", maxLength);
    if (splitPoint === -1 || splitPoint < maxLength / 2) {
      splitPoint = maxLength;
    }

    chunks.push(remaining.substring(0, splitPoint));
    remaining = remaining.substring(splitPoint).trimStart();
  }

  return chunks;
}

export async function startBot(): Promise<void> {
  await client.login(config.discordToken);
}

export function stopBot(): void {
  stopReminderService();
  client.destroy();
}
