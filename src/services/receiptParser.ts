import { processMessage } from "../gemini.js";
import type { ChatMessage, ProcessResult } from "../gemini.js";

/**
 * レシート画像を解析して支出を記録する（§3.4.2）。
 * Geminiに画像を送信し、Function Callingを通じてaddExpenseを呼び出させる。
 *
 * @param botId - 実行中のBotインスタンスID
 * @param userId - DiscordユーザーID（データ分離キー）
 * @param imageBase64 - レシート画像のbase64データ
 * @param mimeType - 画像のMIMEタイプ
 * @param additionalText - ユーザーからの追加テキスト
 * @returns Geminiの応答（テキスト・Embed・添付）
 */
export async function parseReceipt(
  botId: string,
  userId: string,
  imageBase64: string,
  mimeType: string,
  additionalText?: string,
  onStatusChange?: (status: "thinking" | "writing" | "idle") => void
): Promise<ProcessResult> {
  const message: ChatMessage = {
    text:
      additionalText ||
      "この画像はレシートです。内容を読み取って、各商品を適切なカテゴリに分類して家計簿に記録してください（source: receipt_ocr）。記録後、対応する支払い予定がありそうなら消込候補も確認してください。",
    imageData: {
      data: imageBase64,
      mimeType,
    },
  };

  return processMessage(botId, userId, message, onStatusChange);
}
