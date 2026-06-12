import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
  addBotMember,
  removeBotMember,
  listBotMembers,
  isBotMember,
} from "../db/botAttributesRepo.js";
import {
  getBotUserNote,
  setBotUserNote,
  appendBotUserNote,
  getBotGuildNote,
  setBotGuildNote,
  appendBotGuildNote,
  BOT_NOTE_MAX_LENGTH,
} from "../db/botNoteRepo.js";
import { searchGuildMessages, type MessageLogRecord } from "../db/messageLogRepo.js";
import { getBotById } from "../db/botRepo.js";
import { addAuditLog } from "../db/auditRepo.js";

// ─── 汎用モード（MCPアシスタント）専用 Function 群 ───────────────────────────
// bot_attributes_requirements.md §4.3.3（利用メンバー管理）/ §4.6（メモリ2層）。
// これらのモジュールは汎用モードのレジストリにのみマージされ、秘書プリセットでは使われない。
// ギルドスコープの Function は ctx.guildId を必須とする（owner DM では宣言自体を含めない）。

/** ハンドラ共通: ギルドコンテキスト必須チェック */
function requireGuild(ctx: ToolContext): string | null {
  if (!ctx.guildId) {
    return JSON.stringify({
      success: false,
      message: "この機能はサーバー（ギルド）内の会話でのみ利用できます。",
    });
  }
  return null;
}

/** Discordメンション形式（<@123> / <@!123>）または生IDからユーザーIDを抽出する */
function extractUserId(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const mention = raw.match(/^<@!?(\d{5,25})>$/);
  if (mention) return mention[1];
  if (/^\d{5,25}$/.test(raw)) return raw;
  return null;
}

// ─── 利用メンバー管理（汎用モードの core に含める。要件 §4.3.3） ──────────────

const memberDeclarations: FunctionDeclaration[] = [
  {
    name: "addBotMember",
    description:
      "このBotの利用メンバーへ新しいユーザーを追加します。メンバーから「@xx を追加して」「○○さんも使えるようにして」と依頼された際に呼び出してください。" +
      "user_id にはメッセージ中のメンション表記（<@数字> 形式）か、DiscordユーザーIDの数字をそのまま渡します。" +
      "追加されたユーザーは、このサーバーでBotにメンションすると利用できるようになります。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        user_id: {
          type: SchemaType.STRING,
          description: "追加するユーザーのメンション表記（例: '<@123456789012345678>'）またはDiscordユーザーID",
        },
      },
      required: ["user_id"],
    },
  },
  {
    name: "removeBotMember",
    description:
      "このBotの利用メンバーからユーザーを外します。削除できるのは「依頼した本人が自分自身を外す場合」と「Bot作成者（owner）による削除」のみです。" +
      "メンバーが他のメンバーの削除を依頼した場合は実行せず、その権限がないことを伝えてください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        user_id: {
          type: SchemaType.STRING,
          description: "削除するユーザーのメンション表記またはDiscordユーザーID（「私を外して」の場合は発話者自身のID）",
        },
      },
      required: ["user_id"],
    },
  },
  {
    name: "listBotMembers",
    description:
      "このサーバーでBotを利用できるメンバーの一覧（DiscordユーザーID）を取得します。「誰が使えるの？」「メンバー一覧を見せて」への回答に使ってください。",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
];

const memberHandlers: FunctionModule["handlers"] = {
  addBotMember(ctx: ToolContext, args: Record<string, unknown>): string {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;

    const targetId = extractUserId(args.user_id);
    if (!targetId) {
      return JSON.stringify({
        success: false,
        message: "ユーザーIDを認識できませんでした。メンション（<@...>）またはユーザーIDの数字で指定してください。",
      });
    }

    if (isBotMember(ctx.botId, ctx.guildId!, targetId)) {
      return JSON.stringify({ success: true, message: "そのユーザーは既に利用メンバーです。" });
    }

    const added = addBotMember(ctx.botId, ctx.guildId!, targetId, ctx.userId);
    if (added) {
      addAuditLog(ctx.userId, "bot.member_add", `${ctx.botId}:${ctx.guildId}:${targetId}`);
    }
    return JSON.stringify({
      success: added,
      message: added
        ? `<@${targetId}> を利用メンバーに追加しました。メンションで利用できるようになったことを伝えてください。`
        : "メンバーの追加に失敗しました。",
    });
  },

  removeBotMember(ctx: ToolContext, args: Record<string, unknown>): string {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;

    const targetId = extractUserId(args.user_id);
    if (!targetId) {
      return JSON.stringify({
        success: false,
        message: "ユーザーIDを認識できませんでした。メンション（<@...>）またはユーザーIDの数字で指定してください。",
      });
    }

    // 権限: 本人による自己削除 or owner のみ（要件 §4.3.3 / §10-10）
    const ownerId = getBotById(ctx.botId)?.user_id;
    const isSelf = targetId === ctx.userId;
    const isOwner = ctx.userId === ownerId;
    if (!isSelf && !isOwner) {
      return JSON.stringify({
        success: false,
        message: "他のメンバーを削除できるのはBot作成者のみです。本人が「私を外して」と依頼するか、作成者に依頼してください。",
      });
    }

    const removed = removeBotMember(ctx.botId, ctx.guildId!, targetId);
    if (removed) {
      addAuditLog(ctx.userId, "bot.member_remove", `${ctx.botId}:${ctx.guildId}:${targetId}`);
    }
    return JSON.stringify({
      success: removed,
      message: removed
        ? `<@${targetId}> を利用メンバーから外しました。`
        : "そのユーザーは利用メンバーに登録されていません。",
    });
  },

  listBotMembers(ctx: ToolContext): string {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;

    const members = listBotMembers(ctx.botId, ctx.guildId!);
    const ownerId = getBotById(ctx.botId)?.user_id;
    return JSON.stringify({
      success: true,
      owner: ownerId ? `<@${ownerId}>（Bot作成者・常に利用可）` : null,
      members: members.map((m) => ({ user: `<@${m.user_id}>`, added_at: m.created_at })),
      count: members.length,
      message: "メンション表記（<@...>）はそのまま返信に使えます。",
    });
  },
};

/** 利用メンバー管理 FunctionModule（汎用モードの core。ギルド会話でのみマージする） */
export const botMemberFunctions: FunctionModule = {
  declarations: memberDeclarations,
  handlers: memberHandlers,
};

// ─── 個人ノート（bot × ユーザー単位。要件 §4.6.2） ───────────────────────────

const myNoteDeclarations: FunctionDeclaration[] = [
  {
    name: "appendMyNote",
    description:
      "発話者本人に関する長期的な情報（好み・役割・背景知識など「覚えておいて」と言われた事柄）を、その人専用の個人ノートへ1行追記します。" +
      "個人ノートは本人が話しかけた時だけ参照され、他のメンバーには見えません。" +
      "サーバー全体で共有すべき情報（ルール・用語・運用手順）は appendGuildNote を使ってください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        content: {
          type: SchemaType.STRING,
          description: "記憶する短い1行の文章（例: '〇〇さんはイベント企画担当'）",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "getMyNote",
    description: "発話者本人の個人ノートの全文を取得します。「私について何を覚えてる？」への回答や、整理・重複確認に使います。",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "setMyNote",
    description:
      "発話者本人の個人ノートを全文置換します。「〇〇を忘れて」への対応や内容整理の際、必ず getMyNote で現状を確認し、" +
      "置換後の内容を本人に提示して承認を得てから呼び出してください（誤消去防止）。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        content: {
          type: SchemaType.STRING,
          description: `整理後のノート全文（${BOT_NOTE_MAX_LENGTH.toLocaleString()}文字以内。改行区切りの箇条書き推奨）`,
        },
      },
      required: ["content"],
    },
  },
];

const myNoteHandlers: FunctionModule["handlers"] = {
  appendMyNote(ctx: ToolContext, args: Record<string, unknown>): string {
    const content = String(args.content ?? "").trim();
    if (!content) {
      return JSON.stringify({ success: false, message: "記憶する内容が空です。" });
    }
    try {
      const full = appendBotUserNote(ctx.botId, ctx.userId, content);
      return JSON.stringify({
        success: true,
        message: "個人ノートに追記しました📝",
        total_length: full.length,
        max_length: BOT_NOTE_MAX_LENGTH,
      });
    } catch (err) {
      return JSON.stringify({ success: false, message: (err as Error).message });
    }
  },

  getMyNote(ctx: ToolContext): string {
    const note = getBotUserNote(ctx.botId, ctx.userId);
    return JSON.stringify({
      success: true,
      content: note,
      length: note.length,
      max_length: BOT_NOTE_MAX_LENGTH,
    });
  },

  setMyNote(ctx: ToolContext, args: Record<string, unknown>): string {
    const content = String(args.content ?? "");
    try {
      setBotUserNote(ctx.botId, ctx.userId, content);
      return JSON.stringify({ success: true, message: "個人ノートを更新しました📝", total_length: content.length });
    } catch (err) {
      return JSON.stringify({ success: false, message: (err as Error).message });
    }
  },
};

/** 個人ノート FunctionModule（汎用モードの memory。ギルド・owner DM の両方でマージする） */
export const botPersonalNoteFunctions: FunctionModule = {
  declarations: myNoteDeclarations,
  handlers: myNoteHandlers,
};

// ─── 共有ノート + ギルド会話検索（bot × ギルド単位。要件 §4.6） ───────────────

/** 本文を最大文字数で切り詰める */
function truncateContent(content: string, maxLength: number): string {
  const chars = Array.from(content);
  if (chars.length <= maxLength) return content;
  return `${chars.slice(0, maxLength).join("")}…`;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toResultEntry(record: MessageLogRecord, maxContentLength: number) {
  return {
    role: record.role,
    created_at: record.created_at,
    content: truncateContent(record.content, maxContentLength),
  };
}

const guildMemoryDeclarations: FunctionDeclaration[] = [
  {
    name: "appendGuildNote",
    description:
      "このサーバー全体で共有すべき知識（サーバーのルール・用語・運用手順・よくある質問への回答など）を共有ノートへ1行追記します。" +
      "共有ノートは利用メンバー全員との会話で参照されます。発話者個人に関する情報は appendMyNote を使ってください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        content: {
          type: SchemaType.STRING,
          description: "記憶する短い1行の文章（例: 'イベント告知は #お知らせ チャンネルで行う'）",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "getGuildNote",
    description: "このサーバーの共有ノートの全文を取得します。「サーバーのルールは？」等への回答や、整理・重複確認に使います。",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "setGuildNote",
    description:
      "このサーバーの共有ノートを全文置換します。内容の整理や項目の削除依頼の際、必ず getGuildNote で現状を確認し、" +
      "置換後の内容を提示して承認を得てから呼び出してください（共有情報の誤消去防止）。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        content: {
          type: SchemaType.STRING,
          description: `整理後のノート全文（${BOT_NOTE_MAX_LENGTH.toLocaleString()}文字以内。改行区切りの箇条書き推奨）`,
        },
      },
      required: ["content"],
    },
  },
  {
    name: "searchConversationLogs",
    description:
      "このサーバーでの過去の会話履歴をキーワードや期間で全文検索します。「前に話してた〇〇どうなった？」「先週の議論を探して」など、" +
      "過去の会話内容を思い出す必要がある場合に呼び出してください。「先週」「今月」などの自然言語の期間は、現在日時を基準に from / to の" +
      "ISO日付（YYYY-MM-DD）へ変換して指定します。検索対象はこのサーバーでの会話のみで、他のサーバーやDMの会話は含まれません。" +
      "結果は新しい順で、各メッセージ本文は200文字までに切り詰められます。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        keyword: {
          type: SchemaType.STRING,
          description: "検索キーワード（例: 'イベント', '役職 申請'）。省略すると期間のみで検索します。",
        },
        from: { type: SchemaType.STRING, description: "検索期間の開始日 (YYYY-MM-DD形式)（任意）" },
        to: { type: SchemaType.STRING, description: "検索期間の終了日 (YYYY-MM-DD形式。その日の終わりまで含む)（任意）" },
        limit: { type: SchemaType.NUMBER, description: "最大取得件数 (デフォルト10件、最大50件)" },
      },
    },
  },
  {
    name: "summarizeConversationTopic",
    description:
      "このサーバーでの特定の話題に関する過去の会話を検索し、要約用の会話ログ（時系列順）を取得します。「〇〇の議論をまとめて」のような" +
      "依頼の際に呼び出してください。このFunctionは要約そのものは行わないため、返された会話ログを読み、あなたが依頼に沿って要約して提示してください。",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        keyword: { type: SchemaType.STRING, description: "要約したい話題のキーワード。省略すると期間のみで検索します。" },
        from: { type: SchemaType.STRING, description: "検索期間の開始日 (YYYY-MM-DD形式)（任意）" },
        to: { type: SchemaType.STRING, description: "検索期間の終了日 (YYYY-MM-DD形式。その日の終わりまで含む)（任意）" },
      },
    },
  },
];

const guildMemoryHandlers: FunctionModule["handlers"] = {
  appendGuildNote(ctx: ToolContext, args: Record<string, unknown>): string {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;
    const content = String(args.content ?? "").trim();
    if (!content) {
      return JSON.stringify({ success: false, message: "記憶する内容が空です。" });
    }
    try {
      const full = appendBotGuildNote(ctx.botId, ctx.guildId!, content);
      return JSON.stringify({
        success: true,
        message: "共有ノートに追記しました📝（このサーバーの利用メンバー全員と共有されます）",
        total_length: full.length,
        max_length: BOT_NOTE_MAX_LENGTH,
      });
    } catch (err) {
      return JSON.stringify({ success: false, message: (err as Error).message });
    }
  },

  getGuildNote(ctx: ToolContext): string {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;
    const note = getBotGuildNote(ctx.botId, ctx.guildId!);
    return JSON.stringify({
      success: true,
      content: note,
      length: note.length,
      max_length: BOT_NOTE_MAX_LENGTH,
    });
  },

  setGuildNote(ctx: ToolContext, args: Record<string, unknown>): string {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;
    const content = String(args.content ?? "");
    try {
      setBotGuildNote(ctx.botId, ctx.guildId!, content);
      return JSON.stringify({ success: true, message: "共有ノートを更新しました📝", total_length: content.length });
    } catch (err) {
      return JSON.stringify({ success: false, message: (err as Error).message });
    }
  },

  async searchConversationLogs(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;

    const keyword = asOptionalString(args.keyword);
    const from = asOptionalString(args.from);
    const to = asOptionalString(args.to);
    let limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 10;
    limit = Math.min(Math.max(limit, 1), 50);

    // スコープ（要件 §4.6.1）: bot_id × guild_id のこのギルドでの会話のみ検索する
    const records = searchGuildMessages(ctx.botId, ctx.guildId!, { keyword, from, to, limit });

    if (records.length === 0) {
      return JSON.stringify({
        success: true,
        message: "条件に一致する過去の会話は見つかりませんでした。キーワードや期間を変えて再検索できます。",
        results: [],
      });
    }

    return JSON.stringify({
      success: true,
      message: `過去の会話が${records.length}件見つかりました（新しい順、本文は200文字まで）。必要に応じてこの内容を踏まえて返答してください。`,
      results: records.map((r) => toResultEntry(r, 200)),
    });
  },

  async summarizeConversationTopic(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
    const guildError = requireGuild(ctx);
    if (guildError) return guildError;

    const keyword = asOptionalString(args.keyword);
    const from = asOptionalString(args.from);
    const to = asOptionalString(args.to);

    if (!keyword && !from && !to) {
      return JSON.stringify({
        success: false,
        message: "要約対象を特定するため、キーワードまたは期間（from/to）のいずれかを指定してください。",
      });
    }

    const found = searchGuildMessages(ctx.botId, ctx.guildId!, { keyword, from, to, limit: 11 });
    const narrowed = found.length > 10;
    const records = found.slice(0, 10);

    if (records.length === 0) {
      return JSON.stringify({
        success: true,
        message: "条件に一致する過去の会話は見つかりませんでした。その旨をユーザーへ伝えてください。",
        logs: [],
      });
    }

    const logs = records.reverse().map((r) => toResultEntry(r, 1000));

    return JSON.stringify({
      success: true,
      message: `${logs.length}件の会話ログを取得しました（時系列順）${narrowed ? "。該当が多いため新しい順の上位10件に絞っています" : ""}。この内容をユーザーの依頼に沿って要約して提示してください。`,
      logs,
    });
  },
};

/** 共有ノート + ギルド会話検索 FunctionModule（汎用モードの memory。ギルド会話でのみマージする） */
export const botGuildMemoryFunctions: FunctionModule = {
  declarations: guildMemoryDeclarations,
  handlers: guildMemoryHandlers,
};
