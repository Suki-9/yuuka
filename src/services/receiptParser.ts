import { processMessage } from "../gemini.js";
import type { ChatMessage } from "../gemini.js";

/**
 * レシート画像を解析して支出を記録する。
 * Geminiに画像を送信し、Function Callingを通じてaddExpenseを呼び出させる。
 *
 * @param userId - Discord ユーザーID
 * @param imageBase64 - レシート画像のbase64データ
 * @param mimeType - 画像のMIMEタイプ
 * @param additionalText - ユーザーからの追加テキスト
 * @returns Geminiの応答テキスト
 */
export async function parseReceipt(
  userId: string,
  imageBase64: string,
  mimeType: string,
  additionalText?: string
): Promise<string> {
  const message: ChatMessage = {
    text:
      additionalText ||
      "この画像はレシートです。内容を読み取って、各商品を適切なカテゴリに分類して家計簿に記録してください。",
    imageData: {
      data: imageBase64,
      mimeType,
    },
  };

  return processMessage(userId, message);
}
