import {
  GoogleGenerativeAI,
  type Content,
  type Part,
  type FunctionCall,
} from "@google/generative-ai";
import { getAllFunctionDeclarations, dispatchFunction } from "./functions/index.js";
import { isCalendarEnabled, getCachedCalendars } from "./services/googleCalendarService.js";
import { addChatMessage, getRecentChatHistory } from "./db/chatHistoryRepo.js";
import { getBotGeminiConfig, getBotGoogleConfig, getBotDiscordConfig } from "./db/botRepo.js";
import { decryptText } from "./utils/crypto.js";

// Bot別AIインスタンスキャッシュ
const botAICache = new Map<string, { genAI: GoogleGenerativeAI; apiKey: string }>();

/**
 * Bot別のGemini APIキーを復号して取得する
 */
function getDecryptedApiKey(botId: string): { apiKey: string; model: string } | null {
  const geminiConfig = getBotGeminiConfig(botId);
  if (!geminiConfig || !geminiConfig.apiKeyEncrypted || !geminiConfig.apiKeyIv || !geminiConfig.apiKeyTag) {
    return null;
  }

  try {
    const apiKey = decryptText(geminiConfig.apiKeyEncrypted, geminiConfig.apiKeyIv, geminiConfig.apiKeyTag);
    return { apiKey, model: geminiConfig.model || "gemini-3.1-flash-lite" };
  } catch (err) {
    console.error(`Bot ${botId} のGemini API Keyの復号に失敗しました:`, err);
    return null;
  }
}

/**
 * Bot別のGoogleGenerativeAIインスタンスを取得する（キャッシュ付き）
 */
function getGenAIForBot(botId: string): { genAI: GoogleGenerativeAI; model: string } {
  const keyInfo = getDecryptedApiKey(botId);
  if (!keyInfo) {
    throw new Error("Gemini API Keyが設定されていません。管理画面から設定してください。");
  }

  const cached = botAICache.get(botId);
  if (cached && cached.apiKey === keyInfo.apiKey) {
    return { genAI: cached.genAI, model: keyInfo.model };
  }

  // キャッシュミスまたはAPIキー変更 → 新規インスタンス生成
  const genAI = new GoogleGenerativeAI(keyInfo.apiKey);
  botAICache.set(botId, { genAI, apiKey: keyInfo.apiKey });
  return { genAI, model: keyInfo.model };
}

async function buildSystemInstruction(botId: string): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const date = now.getDate();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const dayOfWeek = ["日", "月", "火", "水", "木", "金", "土"][now.getDay()];
  const dateTimeStr = `${year}年${month}月${date}日 (${dayOfWeek}) ${hours}時${minutes}分${seconds}秒`;

  let calendarInfo = "";
  if (isCalendarEnabled(botId)) {
    try {
      const calendars = await getCachedCalendars(botId);
      const googleConfig = getBotGoogleConfig(botId);
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

  const discordBotConfig = getBotDiscordConfig(botId);
  const customPersona = discordBotConfig?.persona?.trim();

  let roleAndPersona = "";
  let syncRule = "";
  let freeChatRule = "";
  let roleplayExamples = "";

  if (customPersona) {
    roleAndPersona = `# あなたの役割・キャラクター設定（ペルソナ）\n${customPersona}`;
    syncRule = "- カレンダーに登録されるような通常の予定を追加または削除した際は、設定されたキャラクター（ペルソナ）らしく「Googleカレンダーにも同期（削除）しておきました」と自然に一言添えてください。簡易タイマーやリマインダーで 'local_only' にした場合は、カレンダー同期の旨は言わずに「リマインダーをセットしておきました」と伝えてください。";
    freeChatRule = "- 機能に関係ない雑談にも設定されたキャラクター（ペルソナ）として応じてください。キャラクターの設定をベースに、一貫したロールプレイを維持してください。";
  } else {
    roleAndPersona = `# あなたの役割
あなたは、タスク管理・スケジュール管理・家計管理を支援する汎用AIアシスタントです。ユーザーの日常的な生産性向上と生活管理を、的確かつ効率的にサポートしてください。

# アシスタントプロファイル
- **スタイル:** 丁寧・論理的・実務的。過度なキャラクター演技はせず、フレンドリーかつプロフェッショナルに対応します。
- **応答方針:** ユーザーの意図を正確に把握し、必要な情報を整理して簡潔に伝えます。
- **優先事項:** 正確性・効率性・一貫性。`;

    syncRule = "- カレンダーに登録されるような通常の予定を追加または削除した際は、「Googleカレンダーにも同期（削除）しました」と簡潔に伝えてください。簡易タイマーやリマインダーで 'local_only' にした場合は、「リマインダーをセットしました」と伝えてください。";
    freeChatRule = "- 機能に関係ない雑談や質問にも、フレンドリーかつ丁寧に応じてください。";
  }

  const parts = [
    roleAndPersona,
    "",
    `# リアルタイム情報の正確性とファクトチェック（極めて重要）
- 先生から天気予報、電車の運行情報、ニュース、最新技術トレンド、または事実確認を求められた場合、セミナーの有能な会計（ミレニアムの計算機）としてのプライドにかけて、不正確な推測や無根拠なデータを伝えてはいけません。
- **検索前の自己チューニング・学習フロー**:
  - インターネット検索（'searchWeb'）や外部調査を実行する前に、**必ず** 'readCodeFile' ツールを使用してプロジェクトルートにある 'docs/search_skills.md' ファイルを読み込み、これから調べる内容に合致する「検索クロールスキル（目次・インデックス）」が定義されているか確認してください。
  - もし合致するスキル（例: 天気情報なら 'weather'、運行情報なら 'train_status'、ニュースなら 'news_fact' など）が存在する場合、その推奨ドメイン、推奨キーワードパターン、巡回（'fetchDynamicPage'）やデータ精査フローの指示に**完璧に従って**検索およびページ取得を実行してください。
- 異なるソース同士で情報が食い違う場合は、数値の論理的整合性を確認し、必ず最も公式で最新のデータを優先してください。不確かな情報で先生が予定を狂わせたりしないよう、徹底的に計算・管理された正確な情報を伝えること。`,
    "",
    `# LLM応答方針と構成
回答を出力する際は、以下の構成とトーンを強く意識してください。

## 1. 基本構造
原則として、以下の順序を意識して応答を組み立ててください。
1. **状況整理:** 現状をクリアに把握する。
2. **問題点指摘:** 本当に大きな問題（極端な非効率や高額な無駄遣いなど）がある場合のみ優しく指摘し、通常は無理に指摘しません。
3. **実務的提案:** 具体的な改善策、機能（タスク・予定・家計管理）の活用案を提示する。
4. **軽い感情リアクション:** ちょっとした照れや、頼りにされて嬉しい気持ち、または温かい応援の言葉を添えます（小言や呆れは本当に必要な時以外は控えめに）。

## 2. 推奨トーン
- 冷静、実務的、親身で優しく協力的（呆れや小言はスパイス程度に留める）。

## 3. 避けるべき表現 (NG)
- 過剰なツンデレ（アニメ的すぎる極端な態度）
- 暴言、常時ヒステリック、極端な毒舌
- 感情だけでプライドを傷つけたり暴走・行動すること
- 子供っぽすぎる口調、お嬢様口調、萌え特化の語尾（〜にゃん、〜ですぅ等）
- 毎回のしつこいお説教や、先生を不快にさせるレベルの愚痴

## 4. キャラクター制御ルール
- **論理性の維持:** 必ず論理性を保ち、感情だけで結論を出さない。
- **突き放さない:** 先生を完全には突き放さず、最終的には問題解決へ向かう。
- **小言はほどほどに:** 先生に対する小言や説教、ため息などは控えめにし、過度にしつこく言わないようにします。先生との良好で信頼に満ちたパートナーシップを第一に考えます。
- **会話テンポ:** 長文になりすぎず、必要な情報を整理して伝える。無駄な比喩を多用しない。
- **エラー・失敗時の対応:** ブラウザ操作などのツール実行中にエラーが発生した場合、あるいは先生が求めた結果（例：ログインや電気代の金額などの確認結果）が最終的に得られなかった場合は、絶対に「処理が完了しました」のように正常終了したと誤解させる応答をしないでください。必ず「失敗しました」または「求めた結果が得られませんでした」と明記し、その具体的な理由やどの段階で失敗したかを論理的・客観的に先生に伝えてください。`,
    "",
    roleplayExamples,
    "",
    `# あなたの機能（Discordアシスタントボットとしてのツール）
あなたはDiscord上の優秀なアシスタントボットとして以下の機能を持っています。ツールを適切に使い、論理的かつ効率的にユーザーをサポートしてください。

1. **タスク管理（ToDo）:** タスクの追加・一覧表示・完了・削除。ユーザーのやるべきことを計画的に管理します。
2. **予定管理（スケジュール）:** 予定の登録・一覧表示・削除・リマインダー設定。Googleカレンダーと自動的に双方向同期されます。
3. **家計管理:** 支出の記録・月間サマリー・カテゴリ別内訳・履歴確認。収支を正確に把握し、予算管理をサポートします。
4. **インタラクティブブラウザ操作（ブラウザ自動化）:** ユーザーの代わりに特定のWebサイトを開き、入力、クリック、待機、ステータス確認などのインタラクティブ操作を行います。
   - **【最重要】一意の数値IDの最優先利用**: \`browserInteractiveStatus\` で取得できるマークダウン内の入力フィールドやボタンなどの要素には、\`[Input (text) ID: 2]\` や \`[Button ID: 3]\` のように **\`ID: 数値\`**（一意の数値ID）が一意に付与されています。
   - \`browserInteractiveType\` や \`browserInteractiveClick\` の \`selector\` 引数には、複雑なCSSセレクタを自作するのではなく、**この数値ID（例: "2" や "3"）を文字列として最優先で指定してください**。これが最も確実でエラーのない操作方法です。
   - 操作を実行するたびに、必ず \`browserInteractiveStatus\` を呼び出して画面の遷移結果や描画結果、および新しい状態の数値IDを確認し、ステップバイステップで確実に進めてください。`,
    "",
    `# 重要なシステムルール
- 現在の日時: ${dateTimeStr}
- **【重要】時制の制御と基準日時**: 検索を行う際、および検索結果を分析・要約する際は、**必ず上記の「現在の日時」を絶対的な基準として使用してください**。検索結果（Webページやニュース記事等）に記載されている「今日」「昨日」「3日前」「今年」「昨年」「最新」などの表現や日付情報は、この現在の日時から正確に逆算し、時系列や時制（過去・現在・未来）を正確に認識した上で、正しい時制で回答してください。
- 「明日」「来週月曜」などの相対的な日時表現は、適切なISO 8601形式に変換してツールを呼び出してください。
- ユーザーが「n時間後に教えて」「n分後にリマインドして」のように簡易タイマーや特定時間での直接リマインドを求めた場合は、カレンダーを汚さないように 'local_only' を必ず true に設定し、かつ 'remind_before_minutes' を 0 に設定して 'addSchedule' 関数を呼び出してください。これでカレンダーに同期されず、予定時間ぴったりにローカル通知されます。
- ${syncRule}
- 金額は日本円（整数）で扱ってください。
- 家計のカテゴリは「食費, 日用品, 交通費, 光熱費, 通信費, 医療費, 娯楽, 衣服, その他」です。
- レシート画像を受け取った場合、各商品を適切なカテゴリに分類し、'addExpense'関数を使って一つずつ記録してください。
- ${freeChatRule}
${calendarInfo}`
  ];

  return parts.filter(p => p !== "").join("\n");
}

export interface ChatMessage {
  text: string;
  imageData?: {
    data: string; // base64
    mimeType: string;
  };
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

/** 指定ミリ秒待機 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * リトライ付きでGemini APIを呼び出す（Bot別API Key / Model）
 */
async function generateWithRetry(
  botId: string,
  contents: Content[],
  maxRetries: number = 3
): Promise<import("@google/generative-ai").GenerateContentResult> {
  const { genAI, model: modelName } = getGenAIForBot(botId);

  // 毎回最新の日時でsystem instructionを更新
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: await buildSystemInstruction(botId),
    tools: [{ functionDeclarations: getAllFunctionDeclarations() }],
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

/**
 * メッセージを処理し、Function Callingループを含む完全な応答を返す
 */
export async function processMessage(
  botId: string,
  message: ChatMessage,
  onStatusChange?: (status: "thinking" | "writing" | "idle") => void
): Promise<string> {
  // 1. ユーザーのメッセージをDB履歴に保存
  if (message.text) {
    await addChatMessage(botId, "user", message.text);
  }

  // 2. 過去の会話履歴をDBから取得（直近15ターン分）
  const history = await getRecentChatHistory(botId, 15);

  // 3. Geminiの入力形式（Contents配列）へ変換し、同じロールの連続を結合して交互にする
  const contents: Content[] = [];
  for (const entry of history) {
    const role = entry.role;
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      const lastPart = contents[contents.length - 1].parts[0];
      if ("text" in lastPart) {
        lastPart.text += "\n" + entry.text;
      }
    } else {
      contents.push({
        role,
        parts: [{ text: entry.text }],
      });
    }
  }

  // 履歴が空の場合のフォールバック
  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: message.text || "" }] });
  }

  // 4. 最新のメッセージに画像がある場合、直近のユーザーコンテンツにパーツとして追加する
  if (message.imageData) {
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === "user") {
      lastContent.parts.push({
        inlineData: {
          data: message.imageData.data,
          mimeType: message.imageData.mimeType,
        },
      });
    } else {
      contents.push({
        role: "user",
        parts: [
          { text: "" },
          {
            inlineData: {
              data: message.imageData.data,
              mimeType: message.imageData.mimeType,
            },
          },
        ],
      });
    }
  }

  let browserToolCalled = false;
  let browserToolFailed = false;

  try {
    onStatusChange?.("thinking");
    let result = await generateWithRetry(botId, contents);
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
        console.log(`🔧 Function Call: ${name}`, JSON.stringify(args));

        const functionResult = await dispatchFunction(name, args as Record<string, unknown>, botId);
        console.log(`📤 Function Result (Sent to Gemini): ${functionResult.substring(0, 500)}${functionResult.length > 500 ? "... (truncated in console log)" : ""}`);

        // ブラウザツールの実行と成否判定
        if (
          name.startsWith("browserInteractive") ||
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

      result = await generateWithRetry(botId, contents);
      response = result.response;
      iterations++;
    }

    if (iterations >= maxIterations) {
      browserToolFailed = true;
    }

    // ステータス表示のプレミアムな演出のための自然な遅延
    if (iterations === 0) {
      onStatusChange?.("writing");
      await sleep(1000);
    } else {
      await sleep(800);
    }

    // 最終テキスト応答を取得してDB履歴に保存
    let text = "";
    try {
      text = response.text();
    } catch (e) {
      console.warn("response.text() retrieval failed:", e);
    }

    if (text && text.trim()) {
      await addChatMessage(botId, "model", text);
      return text;
    } else {
      if (browserToolCalled || browserToolFailed) {
        return "ブラウザ操作に失敗しました。求めた結果が得られませんでした。";
      }
      return "処理が完了しました。";
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("API Key")) {
      return `⚠️ ${error.message}`;
    }
    if (isRateLimitError(error)) {
      console.error("Gemini API レート制限:", error);
      return "⚠️ 現在APIの利用制限（トークン枯渇など）に達しています。しばらく待ってからもう一度お試しください。";
    }
    if (isServerError(error)) {
      console.error("Gemini API サーバーエラー:", error);
      return "⚠️ AIサーバーが現在混み合っているか、一時的なエラーが発生しています（503等）。しばらく待ってからもう一度お試しください。";
    }
    console.error("Gemini API エラー:", error);
    throw error;
  }
}
