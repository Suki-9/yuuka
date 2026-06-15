import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { addEntry, listEntries, deleteEntry } from "../db/clipboardRepo.js";
import { toDbDateTime } from "../utils/datetime.js";

// ─── クリップボード / 一時メモ Function（§3.10） ─────────────────────────────


const declarations: FunctionDeclaration[] = [
  {
    name: "addClipboardEntry",
    description:
      "「今日・今だけ」の揮発的な一時メモをクリップボードに保存します（例:「今日の会議メモ」「あとで調べるURL」「買い物リスト」）。" +
      "期限（TTL）付きで自動削除されます（デフォルト24時間）。長期的な属性・背景知識は appendContextNote を使うこと。" +
      "クリップボードはLLMコンテキストへ常時注入されないため、ユーザーが参照を求めたら listClipboardEntries を呼んでください（§3.10）。" +
      "「今週中だけ」→ ttl_hours: 168、「1時間後に消して」→ ttl_hours: 1 のように自然言語のTTL指定を変換すること。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        content: { type: SchemaType.STRING, description: "メモの内容" },
        ttl_hours: {
          type: SchemaType.NUMBER,
          description: "保持時間（時間単位）。省略時は24時間。0を指定すると無期限",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "listClipboardEntries",
    description:
      "クリップボード（一時メモ）の有効なエントリ一覧を取得します。「メモを見せて」「さっきクリップした内容は？」などの依頼時に呼び出します。",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "deleteClipboardEntry",
    description: "クリップボードの指定エントリを削除します。「〇〇のメモを消して」への対応時に、listClipboardEntries でIDを確認してから呼び出します。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entry_id: { type: SchemaType.NUMBER, description: "削除するエントリのID" },
      },
      required: ["entry_id"],
    },
  },
];

const handlers: FunctionModule["handlers"] = {
  addClipboardEntry(ctx: ToolContext, args: Record<string, unknown>): string {
    const content = String(args.content ?? "").trim();
    if (!content) {
      return JSON.stringify({ success: false, message: "メモの内容が空です。" });
    }

    const ttlHoursRaw = args.ttl_hours === undefined ? 24 : Number(args.ttl_hours);
    if (!Number.isFinite(ttlHoursRaw) || ttlHoursRaw < 0) {
      return JSON.stringify({ success: false, message: "ttl_hours は0以上の数値で指定してください。" });
    }

    // 0 = 無期限（§3.10.4: expires_at NULL）
    const expiresAt =
      ttlHoursRaw === 0 ? null : toDbDateTime(new Date(Date.now() + ttlHoursRaw * 60 * 60 * 1000));

    const entry = addEntry(ctx.userId, ctx.botId, content, expiresAt);
    return JSON.stringify({
      success: true,
      message:
        ttlHoursRaw === 0
          ? "クリップボードに保存しました（無期限）📎"
          : `クリップボードに保存しました（${ttlHoursRaw}時間後に自動削除）📎`,
      entry: { id: entry.id, content: entry.content, expires_at: entry.expires_at },
    });
  },

  listClipboardEntries(ctx: ToolContext): string {
    const entries = listEntries(ctx.userId, ctx.botId);
    return JSON.stringify({
      success: true,
      count: entries.length,
      entries: entries.map((e) => ({
        id: e.id,
        content: e.content,
        expires_at: e.expires_at ?? "無期限",
        created_at: e.created_at,
      })),
    });
  },

  deleteClipboardEntry(ctx: ToolContext, args: Record<string, unknown>): string {
    const id = Number(args.entry_id);
    if (!Number.isInteger(id)) {
      return JSON.stringify({ success: false, message: "entry_id が不正です。" });
    }
    const ok = deleteEntry(ctx.userId, ctx.botId, id);
    return JSON.stringify({
      success: ok,
      message: ok ? "メモを削除しました🗑️" : "指定されたメモが見つかりませんでした。",
    });
  },
};

/** クリップボード FunctionModule */
export const clipboardFunctions: FunctionModule = {
  declarations,
  handlers,
};
