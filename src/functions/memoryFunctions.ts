import { addMemory } from "../db/memoryRepo.js";

export function addBotMemory(botId: string, args: { content: string }): string {
  const { content } = args;
  if (!content || !content.trim()) {
    return JSON.stringify({ success: false, message: "内容が空です。" });
  }

  try {
    const record = addMemory(botId, content.trim());
    return JSON.stringify({
      success: true,
      message: `記憶（メモ）「${content.trim()}」を新しく追加しました。会話のたびに参照されます。`,
      memory: record
    });
  } catch (err: any) {
    console.error("addBotMemory error:", err);
    return JSON.stringify({ success: false, message: `記憶の追加に失敗しました: ${err.message}` });
  }
}
