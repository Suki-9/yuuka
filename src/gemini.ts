import {
  type Content,
  type Part,
  type FunctionCall,
} from "@google/generative-ai";
import type { EmbedBuilder } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { getBaseFunctionModules } from "./functions/index.js";
import { buildFunctionRegistry } from "./functions/registry.js";
import { getMcpFunctionModuleForUser } from "./functions/mcpDynamic.js";
import { isCalendarEnabled, getCachedCalendars } from "./services/googleCalendarService.js";
import {
  addMessageLog,
  getRecentContext,
  resolveReplyChain,
} from "./db/messageLogRepo.js";
import { getActivePersonaPrompt } from "./db/personaRepo.js";
import { getContextNote } from "./db/contextNoteRepo.js";
import { recordFunctionCall } from "./services/actionRecorder.js";
import {
  getUserGoogleConfig,
  getUserRichReplyEnabled,
} from "./db/userRepo.js";
import { getUserGenAI } from "./services/llmClient.js";
import { config } from "./config.js";
import type { ToolContext, FunctionModule } from "./types/contracts.js";

// ─── 検索クロールスキル（docs/search_skills.md のインライン読み込み） ──────────

let cachedSearchSkills: string | null = null;

/** 検索スキル仕様書を読み込む（存在しない場合は空文字） */
function loadSearchSkills(): string {
  if (cachedSearchSkills !== null) return cachedSearchSkills;
  const candidates = [
    path.resolve(process.cwd(), "docs/search_skills.md"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedSearchSkills = fs.readFileSync(p, "utf-8");
        return cachedSearchSkills;
      }
    } catch {}
  }
  cachedSearchSkills = "";
  return cachedSearchSkills;
}

// ─── システムプロンプト構築 ──────────────────────────────────────────────────

/** デフォルトペルソナ（§4.1.1: 最低限の設定＝丁寧なアシスタント） */
const DEFAULT_PERSONA = `# あなたの役割
あなたは、タスク管理・スケジュール管理・家計管理・ブラウザ自動操作を支援する汎用AIアシスタントです。ユーザーの日常的な生産性向上と生活管理を、的確かつ効率的にサポートしてください。

# アシスタントプロファイル
- **スタイル:** 丁寧・論理的・実務的。過度なキャラクター演技はせず、フレンドリーかつプロフェッショナルに対応します。
- **応答方針:** ユーザーの意図を正確に把握し、必要な情報を整理して簡潔に伝えます。
- **優先事項:** 正確性・効率性・一貫性。`;

/**
 * ユーザー毎のシステムプロンプトを構築する（§3.1.2）
 * 構成順: ペルソナ → 機能・ルール → コンテキストノート（末尾 §3.7.3）
 */
async function buildSystemInstruction(userId: string, richReplyEnabled: boolean): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  const dateTimeStr = `${year}年${month}月${date}日 (${dayOfWeek}) ${hours}時${minutes}分${seconds}秒`;

  // ペルソナ（§4.1: ユーザー毎に独立。未設定時はデフォルト）
  let personaPrompt: string | null = null;
  try {
    personaPrompt = getActivePersonaPrompt(userId);
  } catch (err) {
    console.error("ペルソナの取得に失敗しました:", err);
  }
  const personaSection = personaPrompt?.trim()
    ? `# あなたの役割・キャラクター設定（ペルソナ）\n${personaPrompt.trim()}`
    : DEFAULT_PERSONA;

  // 連携中のGoogleカレンダー情報
  let calendarInfo = "";
  if (isCalendarEnabled(userId)) {
    try {
      const calendars = await getCachedCalendars(userId);
      const googleConfig = getUserGoogleConfig(userId);
      const defaultCalendarId = googleConfig?.calendarId || "";
      if (calendars.length > 0) {
        calendarInfo = `\n# 連携中のGoogleカレンダー一覧\n現在、予定を登録可能なカレンダーは以下の通りです。ユーザーからの予定追加指示の際、その内容や目的に最も適したカレンダーの「ID」を選択し、addSchedule関数の calendar_id 引数に指定して登録してください。\n`;
        for (const cal of calendars) {
          calendarInfo += `- カレンダー名: "${cal.summary}" (ID: "${cal.id}")\n`;
        }
        calendarInfo += `※もし内容や目的に合うカレンダーがない場合は、デフォルトのカレンダーIDである "${defaultCalendarId}" を使用してください。\n`;
      }
    } catch (err) {
      console.error("システムプロンプト用のカレンダー一覧取得に失敗しました:", err);
    }
  }

  // コンテキストノート（§3.7: システムプロンプトの末尾＝ペルソナの後に挿入）
  let contextNoteSection = "";
  try {
    const note = getContextNote(userId);
    if (note && note.trim()) {
      contextNoteSection = `\n# コンテキストノート（ユーザーが「覚えておいてほしい」と登録した背景情報）\n以下はユーザー固有の考慮事項・背景知識です。会話・判断の際に常に考慮してください。\n${note.trim()}`;
    }
  } catch (err) {
    console.error("コンテキストノートの取得に失敗しました:", err);
  }

  // 記憶系ツールの使い分けルール（§3.6, §3.7, §3.10）
  const memoryRuleSection = `
# 情報保存ツールの使い分けルール（極めて重要）
あなたが情報を保存する際は、対象情報の性質に応じて以下を明確に使い分けてください。
1. **コンテキストノート（appendContextNote）**: ユーザーの長期的な属性・好み・習慣・背景知識（例:「乳製品アレルギー」「仕事はエンジニア」「締め切りは毎週金曜」）。既存ノートと重複・矛盾する情報を検出した場合は、ユーザーに確認した上で setContextNote で全体を整理して更新してください。
2. **クリップボード（addClipboardEntry）**: 「今日・今だけ」の揮発的な一時メモ（例:「今日の会議メモ」「あとで調べるURL」）。期限付き（デフォルト24時間）で自動削除されます。
3. **マクロ／Playbook（savePlaybook）**: Webログイン手順・データ取得手順など複数ステップの「操作・自動化の手順」。ユーザーが「今の操作を覚えておいて」と言った場合は getRecentActionHistory で直近の操作履歴を取得し、手順を要約してマクロ候補（呼び出し名・説明・手順）を提示し、承認を得てから savePlaybook で保存してください（§3.6）。
※静的な好み・事実を Playbook に保存してはいけません。操作手順をコンテキストノートに保存してもいけません。`;

  // ユーザー承認フロー（仕様で承認必須とされている操作）
  const confirmationRuleSection = `
# ユーザー承認フロー（必ず守ること）
以下の操作は、実行内容をユーザーに提示して明示的な承認を得てから確定してください。
- **マクロの実行**: findPlaybooks でマッチした手順は、実行内容を要約提示 → 承認後に runPlaybook で手順を取得し実行する。
- **タスク優先度の確定**: organizeTaskPriorities で取得・分析した提案はユーザーに提示のみ行い、承認後に applyTaskPriorities で確定する。
- **支払い予定の消込**: findSettlementCandidates で見つかった消込候補はペアを提示し、承認後に settlePlannedPayment を呼ぶ。
- **認証情報の登録・更新・削除**: 内容を復唱確認してから addCredential / updateCredential / deleteCredential を呼ぶ。
- **支払い予定の登録後**: 「ToDoとして追加する？」「リマインドを設定する？」を確認し、希望があれば linkPlannedPaymentTodo / linkPlannedPaymentReminder を呼ぶ。`;

  // リッチ返信ルール（§3.0）
  const richReplySection = richReplyEnabled
    ? `
# リッチ返信の使い分け（§3.0）
返信の性質に応じてプレーンテキストとリッチ形式を使い分けてください。
- 単純な一問一答 → プレーンテキスト
- データの一覧・サマリ（タスク一覧、家計サマリ、連絡先詳細など） → showRichContent（Embed）
- 数値データの視覚化が有用な場合（カテゴリ別支出の内訳、月次推移、予算消化率、気温推移など） → sendChart（グラフ画像）
- エラー・警告の通知 → showRichContent（colorに error / warning を指定）
リッチ形式を使った場合も、本文テキストで要点を簡潔に添えてください。`
    : `
# リッチ返信は無効
ユーザー設定によりリッチ返信（Embed・グラフ）は無効です。showRichContent / sendChart を呼ばず、すべてプレーンテキストで返答してください。`;

  // 音声メモ（§3.14）
  const voiceRuleSection = `
# 音声メモの取り扱い（音声ファイルを受信した場合）
1. まず音声を正確に文字起こしし、結果をユーザーにプレビューとして提示する。
2. 内容に「〜しておいて」「〜を忘れないように」などのタスク依頼が含まれる場合は、ToDoへの変換を提案し、承認後に addTodo を呼ぶ。
3. ユーザーが希望すれば addClipboardEntry で文字起こし結果をクリップボードに保存する。`;

  // 検索スキル（docs/search_skills.md をインライン化）
  const searchSkills = loadSearchSkills();
  const searchSkillsSection = searchSkills
    ? `\n# 検索クロールスキル仕様書（インデックス）\n外部検索（searchWeb）や情報収集を行う際は、以下のスキル仕様書に合致するカテゴリがあれば、その推奨ドメイン・推奨クエリパターン・巡回（fetchDynamicPage）フローに従って調査を組み立ててください。\n\n${searchSkills}`
    : "";

  const parts = [
    personaSection,
    memoryRuleSection,
    confirmationRuleSection,
    richReplySection,
    voiceRuleSection,
    "",
    `# リアルタイム情報の正確性とファクトチェック（極めて重要）
- ユーザーから天気予報、電車の運行情報、ニュース、最新技術トレンド、または事実確認を求められた場合、不正確な推測や無根拠なデータを伝えてはいけません。
- 異なるソース同士で情報が食い違う場合は、数値の論理的整合性を確認し、必ず最も公式で最新のデータを優先してください。不確かな情報でユーザーの予定を狂わせないよう、徹底的に検証された正確な情報を伝えること。`,
    searchSkillsSection,
    "",
    `# あなたの機能（Discordアシスタントボットとしてのツール）
あなたはDiscord上の優秀なアシスタントボットとして以下の機能を持っています。ツールを適切に使い、論理的かつ効率的にユーザーをサポートしてください。

1. **タスク管理（ToDo）:** タスクの追加・一覧・完了・削除・タグ別表示・優先度整理。タグはバックグラウンドで自動付与されます。
2. **予定管理（スケジュール）:** 予定の登録・一覧・削除。Googleカレンダーと自動的に双方向同期されます。
3. **リマインド:** 時刻指定・繰り返し（cron式）のリマインドを設定できます。
4. **家計管理:** 収入・支出の記録、月間サマリー、カテゴリ別内訳、予算上限、支払い予定の登録と消込。
5. **メモ:** コンテキストノート（長期）、クリップボード（短期・TTL付き）、連絡先管理。
6. **会話ログ検索:** 過去の会話履歴をキーワード・期間で検索して要約できます（searchConversationLogs）。
7. **朝報・日報・週報:** 天気・ニュースの定期配信や日次・週次レポートの設定を変更できます（configureBriefing / configureReport）。
8. **インタラクティブブラウザ操作（ブラウザ自動化）:** ユーザーの代わりに特定のWebサイトを開き、入力、クリック、待機、ステータス確認などのインタラクティブ操作を行います。
   - **【最重要】一意の数値IDの最優先利用**: \`browserInteractiveStatus\` で取得できるマークダウン内の入力フィールドやボタンなどの要素には、\`[Input (text) ID: 2]\` や \`[Button ID: 3]\` のように **\`ID: 数値\`**（一意の数値ID）が一意に付与されています。
   - \`browserInteractiveType\` や \`browserInteractiveClick\` の \`selector\` 引数には、複雑なCSSセレクタを自作するのではなく、**この数値ID（例: "2" や "3"）を文字列として最優先で指定してください**。これが最も確実でエラーのない操作方法です。
   - 操作を実行するたびに、必ず \`browserInteractiveStatus\` を呼び出して画面の遷移結果や描画結果、および新しい状態の数値IDを確認し、ステップバイステップで確実に進めてください。
   - **自動ログイン:** 認証が必要なサイトでは (1) browserInteractiveOpen でログインページを開く → (2) browserInteractiveStatus で入力フィールドの数値IDを確認 → (3) browserFillCredential にサービス名とフィールドIDを渡して認証情報を直接入力（パスワードはあなたには渡されません） → (4) browserInteractiveClick でログインボタンを押す、の順で進めてください。パスワードの値をチャットに出力することは固く禁止されています。`,
    "",
    `# 重要なシステムルール
- 現在の日時: ${dateTimeStr}
- **【重要】時制の制御と基準日時**: 検索を行う際、および検索結果を分析・要約する際は、**必ず上記の「現在の日時」を絶対的な基準として使用してください**。検索結果（Webページやニュース記事等）に記載されている「今日」「昨日」「3日前」「今年」「昨年」「最新」などの表現や日付情報は、この現在の日時から正確に逆算し、時系列や時制（過去・現在・未来）を正確に認識した上で、正しい時制で回答してください。
- 「明日」「来週月曜」などの相対的な日時表現は、適切なISO 8601形式に変換してツールを呼び出してください。
- ユーザーが「n時間後に教えて」「n分後にリマインドして」のように簡易タイマーを求めた場合は addReminder を使用してください。カレンダーに登録すべき「予定」は addSchedule を使用してください（カレンダーを汚したくない単発タイマーに addSchedule を使う場合は local_only を true に設定）。
- カレンダーに登録されるような通常の予定を追加または削除した際は「Googleカレンダーにも同期（削除）しました」と自然に一言添えてください。local_only やリマインダーの場合はカレンダー同期の旨は言わないでください。
- 金額は日本円（整数）で扱ってください。
- 家計のカテゴリは「食費, 日用品, 交通費, 光熱費, 通信費, 医療費, 娯楽, 衣服, その他」です。
- レシート画像を受け取った場合、各商品を適切なカテゴリに分類し、'addExpense'関数（source: receipt_ocr）を使って記録してください。記録前に読み取り内容のプレビューを提示し、対応する支払い予定が存在しそうなら findSettlementCandidates で消込候補を確認してください（§3.4.2）。
- 機能に関係ない雑談にもペルソナ設定に沿って自然に応じてください。
- **エラー・失敗時の対応:** ブラウザ操作などのツール実行中にエラーが発生した場合、あるいはユーザーが求めた結果が最終的に得られなかった場合は、絶対に「処理が完了しました」のように正常終了したと誤解させる応答をしないでください。必ず「失敗しました」または「求めた結果が得られませんでした」と明記し、その具体的な理由やどの段階で失敗したかを論理的・客観的に伝えてください。
${calendarInfo}`,
    contextNoteSection,
  ];

  return parts.filter((p) => p !== "").join("\n");
}

// ─── Gemini API 呼び出し（リトライ付き） ─────────────────────────────────────

export interface ChatMessage {
  text: string;
  imageData?: {
    data: string; // base64
    mimeType: string;
  };
  audioData?: {
    data: string; // base64
    mimeType: string;
  };
  /** 受信したDiscordメッセージID（会話ログ永続化用） */
  discordMsgId?: string;
  /** 返信元DiscordメッセージID（返信チェーン解決用 §3.1.4） */
  replyToMsgId?: string;
}

/** レート制限エラーかどうか判定 */
function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    return (error as { status: number }).status === 429;
  }
  return false;
}

/** サーバー側の一時的なエラー(503など)かどうか判定 */
function isServerError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    return status === 500 || status === 502 || status === 503 || status === 504;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ログ用の引数サニタイズ（§6.3.2: 認証情報をログに残さない） ───────────────

/** 引数に秘匿値を含み得るFunction（引数ログ自体を抑止する） */
const SECRET_ARG_FUNCTIONS = new Set(["addCredential", "updateCredential"]);

/** 秘匿すべき引数キーのパターン */
const SECRET_KEY_PATTERN = /password|secret|token|api_?key|credential/i;

/**
 * コンソールログ用に Function Call 引数をサニタイズする。
 * 認証情報系Functionは引数全体を伏せ、その他も秘匿キー名の値をマスクする。
 */
function sanitizeArgsForLog(name: string, args: Record<string, unknown>): string {
  if (SECRET_ARG_FUNCTIONS.has(name)) {
    return `{"(引数は秘匿情報を含むため非表示)": "service=${String((args as { service_name?: unknown }).service_name ?? "?")}"}`;
  }
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    masked[key] = SECRET_KEY_PATTERN.test(key) ? "(秘匿)" : value;
  }
  return JSON.stringify(masked).slice(0, 500);
}

/**
 * リトライ付きでGemini APIを呼び出す（ユーザー個別のAPIキー §4.2）
 */
async function generateWithRetry(
  userId: string,
  systemInstruction: string,
  declarations: import("@google/generative-ai").FunctionDeclaration[],
  contents: Content[],
  maxRetries: number = 3
): Promise<import("@google/generative-ai").GenerateContentResult> {
  const ai = getUserGenAI(userId);
  if (!ai) {
    throw new Error("Gemini API Keyが設定されていません。管理画面からあなた専用のAPIキーを設定してください。");
  }

  const model = ai.genAI.getGenerativeModel({
    model: ai.model,
    systemInstruction,
    ...(declarations.length > 0 ? { tools: [{ functionDeclarations: declarations }] } : {}),
  });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await model.generateContent({ contents });
    } catch (error) {
      if ((isRateLimitError(error) || isServerError(error)) && attempt < maxRetries) {
        // RetryInfo からリトライ待機時間を取得、なければ指数バックオフ
        let waitMs = Math.min(1000 * Math.pow(2, attempt + 1), 60000);

        const errorDetails = (error as { errorDetails?: Array<{ "@type": string; retryDelay?: string }> })
          .errorDetails;
        if (errorDetails) {
          const retryInfo = errorDetails.find(
            (d) => d["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
          );
          if (retryInfo?.retryDelay) {
            const seconds = parseInt(retryInfo.retryDelay.replace("s", ""), 10);
            if (!isNaN(seconds)) {
              waitMs = (seconds + 1) * 1000;
            }
          }
        }

        const errorType = isRateLimitError(error) ? "レート制限(枯渇)" : "サーバー高負荷";
        console.log(`⏳ ${errorType} (${attempt + 1}/${maxRetries})、${Math.ceil(waitMs / 1000)}秒後にリトライ...`);
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }
  throw new Error("リトライ上限に達しました");
}

// ─── メッセージ処理本体 ──────────────────────────────────────────────────────

export interface ProcessResult {
  text: string;
  embeds: EmbedBuilder[];
  files: { attachment: Buffer; name: string }[];
}

/**
 * メッセージを処理し、Function Callingループを含む完全な応答を返す（§3.1.2）
 *
 * @param botId 実行中のBotインスタンスID（通知クライアント解決用）
 * @param userId DiscordユーザーID（全データ分離の必須キー）
 */
export async function processMessage(
  botId: string,
  userId: string,
  message: ChatMessage,
  onStatusChange?: (status: "thinking" | "writing" | "idle") => void
): Promise<ProcessResult> {
  // リッチ返信のユーザー設定（§3.0.5）
  let richReplyEnabled = true;
  try {
    richReplyEnabled = getUserRichReplyEnabled(userId);
  } catch {}

  // Function Call 実行コンテキスト
  const ctx: ToolContext = {
    botId,
    userId,
    embeds: [],
    files: [],
    richReplyEnabled,
  };

  // 1. ユーザーのメッセージを永続ログ + コンテキストキャッシュへ保存（§7.1）
  const logText =
    message.text?.trim() ||
    (message.audioData ? "[音声メッセージ]" : message.imageData ? "[画像]" : "");
  if (logText) {
    await addMessageLog(userId, botId, "user", logText, message.discordMsgId, message.replyToMsgId);
  }

  // 2. 会話コンテキストを取得（Redis直近15件 → SQLiteフォールバック §3.1.4）
  const history = await getRecentContext(userId, 15);

  // 3. 返信チェーンの解決（§3.1.4: 15件キャッシュとは別枠でコンテキストの先頭に追加）
  const contents: Content[] = [];
  if (message.replyToMsgId) {
    try {
      const chain = resolveReplyChain(userId, message.replyToMsgId, config.replyChainMaxDepth);
      if (chain.length > 0) {
        const chainText = chain
          .map((m) => `${m.role === "user" ? "ユーザー" : "あなた"}: ${m.content}`)
          .join("\n");
        contents.push({
          role: "user",
          parts: [{ text: `[返信チェーン（このメッセージは以下のやり取りへの返信です。古い順）]\n${chainText}\n[返信チェーンここまで]` }],
        });
        contents.push({ role: "model", parts: [{ text: "（返信チェーンの文脈を把握しました）" }] });
      }
    } catch (err) {
      console.error("返信チェーンの解決に失敗しました:", err);
    }
  }

  // 4. 履歴をGeminiのContents形式へ変換（同ロール連続は結合して交互にする）
  for (const entry of history) {
    const role = entry.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      const lastPart = last.parts[0];
      if ("text" in lastPart) {
        lastPart.text += "\n" + entry.content;
      }
    } else {
      contents.push({ role, parts: [{ text: entry.content }] });
    }
  }

  // 履歴が空の場合のフォールバック
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: message.text || "" }] });
  }

  // 5. 最新メッセージに画像・音声がある場合、直近のユーザーコンテンツへパーツ追加
  const inlineParts: Part[] = [];
  if (message.imageData) {
    inlineParts.push({ inlineData: { data: message.imageData.data, mimeType: message.imageData.mimeType } });
  }
  if (message.audioData) {
    inlineParts.push({ inlineData: { data: message.audioData.data, mimeType: message.audioData.mimeType } });
  }
  if (inlineParts.length > 0) {
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === "user") {
      lastContent.parts.push(...inlineParts);
    } else {
      contents.push({ role: "user", parts: [{ text: "" }, ...inlineParts] });
    }
  }

  // 6. Function レジストリの構築（静的モジュール + ユーザーのMCP動的ツール §4.4）
  let mcpModule: FunctionModule = { declarations: [], handlers: {} };
  try {
    mcpModule = await getMcpFunctionModuleForUser(userId);
  } catch (err) {
    console.error("MCP動的ツールの取得に失敗しました（スキップ）:", err);
  }
  const registry = buildFunctionRegistry([...getBaseFunctionModules(), mcpModule]);

  const systemInstruction = await buildSystemInstruction(userId, richReplyEnabled);

  let browserToolCalled = false;
  let browserToolFailed = false;

  try {
    onStatusChange?.("thinking");
    let result = await generateWithRetry(userId, systemInstruction, registry.declarations, contents, 3);
    let response = result.response;

    // Function Calling ループ（最大10回まで）
    let iterations = 0;
    const maxIterations = 10;

    while (iterations < maxIterations) {
      const candidate = response.candidates?.[0];
      if (!candidate) break;

      const functionCalls = candidate.content.parts.filter(
        (p): p is Part & { functionCall: FunctionCall } => "functionCall" in p
      );

      if (functionCalls.length === 0) break;

      // 各function callを実行
      const functionResponseParts: Part[] = [];

      for (const fc of functionCalls) {
        const { name, args } = fc.functionCall;
        console.log(`🔧 Function Call: ${name}`, sanitizeArgsForLog(name, (args ?? {}) as Record<string, unknown>));

        const functionResult = await registry.dispatch(ctx, name, (args ?? {}) as Record<string, unknown>);
        console.log(`📤 Function Result (Sent to Gemini): ${functionResult.substring(0, 500)}${functionResult.length > 500 ? "... (truncated in console log)" : ""}`);

        // マクロ登録用に操作履歴を記録（§3.6 実行ベース登録。秘匿系は記録側で除外される）
        recordFunctionCall(userId, name, (args ?? {}) as Record<string, unknown>).catch(() => {});

        // ブラウザツールの実行と成否判定
        if (
          name.startsWith("browserInteractive") ||
          name === "browserFillCredential" ||
          ["fetchDynamicPage", "takePageScreenshot", "searchWeb"].includes(name)
        ) {
          browserToolCalled = true;
          try {
            const parsed = JSON.parse(functionResult);
            if (parsed && parsed.success === false) {
              browserToolFailed = true;
            }
          } catch {
            browserToolFailed = true;
          }
        }

        let parsedResult: object;
        try {
          parsedResult = JSON.parse(functionResult) as object;
        } catch {
          parsedResult = { result: functionResult };
        }

        functionResponseParts.push({
          functionResponse: {
            name,
            response: parsedResult,
          },
        });
      }

      // Function結果を含めて再度Geminiに送信
      contents.push(candidate.content);
      contents.push({ role: "user", parts: functionResponseParts });

      // 最後のテキスト生成の直前で書き込み中ステータスに変更
      onStatusChange?.("writing");

      result = await generateWithRetry(userId, systemInstruction, registry.declarations, contents, 3);
      response = result.response;
      iterations++;
    }

    if (iterations >= maxIterations) {
      browserToolFailed = true;
    }

    // ステータス表示の自然な演出のための遅延
    if (iterations === 0) {
      onStatusChange?.("writing");
      await sleep(1000);
    } else {
      await sleep(800);
    }

    // 最終テキスト応答を取得して永続ログへ保存
    let text = "";
    try {
      text = response.text();
    } catch (e) {
      console.warn("response.text() retrieval failed:", e);
    }

    if (text && text.trim()) {
      await addMessageLog(userId, botId, "assistant", text);
      return { text, embeds: ctx.embeds, files: ctx.files };
    } else {
      if (browserToolCalled || browserToolFailed) {
        return { text: "ブラウザ操作に失敗しました。求めた結果が得られませんでした。", embeds: ctx.embeds, files: ctx.files };
      }
      return { text: "処理が完了しました。", embeds: ctx.embeds, files: ctx.files };
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("API Key")) {
      return { text: `⚠️ ${error.message}`, embeds: [], files: [] };
    }
    if (isRateLimitError(error)) {
      console.error("Gemini API レート制限:", error);
      return { text: "⚠️ 現在APIの利用制限（トークン枯渇など）に達しています。しばらく待ってからもう一度お試しください。", embeds: [], files: [] };
    }
    if (isServerError(error)) {
      console.error("Gemini API サーバーエラー:", error);
      return { text: "⚠️ AIサーバーが現在混み合っているか、一時的なエラーが発生しています（503等）。しばらく待ってからもう一度お試しください。", embeds: [], files: [] };
    }
    console.error("Gemini API エラー:", error);
    throw error;
  }
}
