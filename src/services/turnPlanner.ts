import {
	type FunctionDeclaration,
	type GoogleGenerativeAI,
	type Schema,
	SchemaType,
} from "@google/generative-ai";

// ─── ターン処理プランナー（Goal 1: 適切なツール利用 / Goal 2: 重い処理の非同期化） ──────
//
// 役割は2つ。
//  (1) 全ツールの「コンパクトな索引」を独立した推論パス（軽量LLM）へ渡し、今回の要求に対する
//      短い処理プラン（手順・利用予定ツール）を立てさせる。これを本ループの systemInstruction へ
//      注入することで、弱いモデルでも「本当に必要な場面で適切なツールを呼ぶ」打率を上げる（強制はしない）。
//  (2) その処理プランから処理ウェイト（推定所要 ms）を見積もり、規定値以上なら呼び出し側が
//      一時応答（中間レスポンス）を返して非同期化する判断材料にする。
//
// 立案に失敗した場合は planTurn が null を返し、プラン注入なしの現行挙動へデグレードする。

/** 重い（ネットワーク/ブラウザ/外部レンダリング）ツール名。実行時の非同期エスカレーション判定に使う。 */
const HEAVY_TOOL_PREFIXES = ["browserInteractive"] as const;
const HEAVY_TOOL_NAMES = new Set<string>([
	"browserFillCredential",
	"fetchDynamicPage",
	"takePageScreenshot",
	"searchWeb",
]);

/** 当該ツールが重い処理（数秒〜数十秒）かどうか。 */
export function isHeavyTool(name: string): boolean {
	if (HEAVY_TOOL_NAMES.has(name)) return true;
	return HEAVY_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

/** 各ツールの代表的な所要ウェイト（ms）。ヒューリスティック見積もりの係数。 */
const HEAVY_TOOL_WEIGHT_MS = 12_000;
const IMAGE_WEIGHT_MS = 3_000;
const AUDIO_WEIGHT_MS = 4_000;

/** プランナーが返す構造化プラン。 */
export interface TurnPlan {
	/** 実行手順（1〜数行の自然文）。systemInstruction への思考メモとして注入する。 */
	steps: string[];
	/** 利用予定のツール名（索引内の name から選ぶ）。 */
	tools: string[];
	/** 推定処理ウェイト（ms）。重い処理ほど大きい。 */
	weightMs: number;
	/** 非同期化が望ましいか（呼び出し側が threshold と weightMs で最終判断する）。 */
	heavy: boolean;
	/** 非同期化する場合にユーザーへ即時返す一時応答メッセージ。 */
	interim: string;
}

/**
 * 全ツール宣言から「コンパクトな索引」を組み立てる（name: 説明の先頭一文）。
 * 本ループには全ツールを提示しつつ、プランナーには軽量な索引だけを渡してコストを抑える。
 */
export function buildToolIndex(declarations: FunctionDeclaration[]): string {
	const lines: string[] = [];
	for (const d of declarations) {
		const desc = (d.description ?? "").replace(/\s+/g, " ").trim();
		// 最初の句点まで、なければ先頭80文字に丸める
		const head =
			desc.split(/[。\n]/)[0]?.slice(0, 80) || desc.slice(0, 80) || "";
		lines.push(`- ${d.name}: ${head}`);
	}
	return lines.join("\n");
}

/**
 * メッセージ内容だけから処理ウェイトの下限を見積もる（LLM プランを補完する安全網）。
 * プランナーが重さを過小評価しても、明らかに重い入力（ブラウザ/検索/複数画像）は拾えるようにする。
 */
export function estimateHeuristicWeightMs(params: {
	text: string;
	imageCount: number;
	hasAudio: boolean;
}): number {
	let ms = 0;
	const t = params.text.toLowerCase();
	// ブラウザ操作・ログイン・フォーム入力・スクレイピング系
	if (
		/(ログイン|log.?in|sign.?in|認証|フォーム|入力して|ポチって|クリックして|操作して|自動化)/.test(
			params.text,
		) ||
		/(password|パスワード)/.test(params.text)
	) {
		ms = Math.max(ms, HEAVY_TOOL_WEIGHT_MS * 2);
	}
	// Web検索・ページ取得・スクリーンショット・調査
	if (
		/(検索して|調べて|ググって|web|サイト|url|http|スクショ|スクリーンショット|screenshot|最新|ニュース|天気|株価|相場)/.test(
			t,
		)
	) {
		ms = Math.max(ms, HEAVY_TOOL_WEIGHT_MS);
	}
	// 複数画像の解析（レシート複数枚など）
	if (params.imageCount > 0) {
		ms = Math.max(ms, params.imageCount * IMAGE_WEIGHT_MS);
	}
	if (params.hasAudio) {
		ms = Math.max(ms, AUDIO_WEIGHT_MS);
	}
	return ms;
}

const PLAN_SCHEMA = {
	type: SchemaType.OBJECT,
	properties: {
		steps: {
			type: SchemaType.ARRAY,
			items: { type: SchemaType.STRING },
			description: "実行手順（簡潔に。最大5項目）",
		},
		tools: {
			type: SchemaType.ARRAY,
			items: { type: SchemaType.STRING },
			description: "利用予定のツール名（索引の name から。不要なら空配列）",
		},
		weightMs: {
			type: SchemaType.NUMBER,
			description:
				"推定処理ウェイト(ミリ秒)。雑談やDB読み書きのみ=200〜800、カレンダー同期=3000、Web検索/ページ取得=10000、ブラウザ操作の連鎖=20000以上",
		},
		interim: {
			type: SchemaType.STRING,
			description:
				"重い処理の場合にユーザーへ即時返す一時応答（例:『承知しました。〜を調べて完了したらお知らせします』）。軽い処理なら空文字。",
		},
	},
	required: ["steps", "tools", "weightMs", "interim"],
} as const;

const PLAN_SYSTEM_INSTRUCTION = `あなたはDiscordアシスタントの「処理プランナー」です。
ユーザーの直近の要求に対し、本体アシスタントが取るべき最小限の実行プランを立ててください。
- 利用可能なツールは後述の索引（name: 説明）にあります。要求の達成に実際に必要なツールだけを tools に挙げてください。
- 雑談・質問への単純回答など、ツールが不要なら tools は空配列にしてください（無理にツールを挙げない）。
- weightMs は処理の重さの見積もりです。ブラウザ操作・Web検索・ページ取得・複数画像の解析は重い（数秒〜数十秒）です。
- 出力は指定のJSONスキーマのみ。余計な文章は出力しないこと。`;

/**
 * 軽量LLMで今回のターンの処理プランを立てる。
 * 失敗時は null を返し、呼び出し側は現行挙動（プラン無し）へデグレードする。
 */
export async function planTurn(
	ai: { genAI: GoogleGenerativeAI; model: string },
	params: {
		text: string;
		imageCount: number;
		hasAudio: boolean;
		toolIndex: string;
		threshold: number;
		modelOverride?: string;
	},
): Promise<TurnPlan | null> {
	const userText = params.text.trim();
	const mediaNote =
		params.imageCount > 0
			? `\n[添付: 画像${params.imageCount}枚]`
			: params.hasAudio
				? "\n[添付: 音声メッセージ1件]"
				: "";
	if (!userText && !mediaNote) return null;

	try {
		const model = ai.genAI.getGenerativeModel(
			{
				model: params.modelOverride || ai.model,
				systemInstruction: PLAN_SYSTEM_INSTRUCTION,
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: PLAN_SCHEMA as unknown as Schema,
					temperature: 0,
					maxOutputTokens: 512,
				},
			},
			{ timeout: 20_000 },
		);

		const prompt = `# 利用可能ツール索引\n${params.toolIndex}\n\n# ユーザーの要求\n${userText || "(テキストなし)"}${mediaNote}`;
		const result = await model.generateContent(prompt);
		const raw = result.response.text();
		const parsed = JSON.parse(raw) as {
			steps?: unknown;
			tools?: unknown;
			weightMs?: unknown;
			interim?: unknown;
		};

		const steps = Array.isArray(parsed.steps)
			? parsed.steps
					.filter((s): s is string => typeof s === "string")
					.slice(0, 5)
			: [];
		const tools = Array.isArray(parsed.tools)
			? parsed.tools.filter((s): s is string => typeof s === "string")
			: [];
		const llmWeight =
			typeof parsed.weightMs === "number" && Number.isFinite(parsed.weightMs)
				? parsed.weightMs
				: 0;
		const interim =
			typeof parsed.interim === "string" ? parsed.interim.trim() : "";

		// LLM 見積もりとヒューリスティック下限の大きい方を採用（過小評価の安全網）。
		const weightMs = Math.max(
			llmWeight,
			estimateHeuristicWeightMs({
				text: params.text,
				imageCount: params.imageCount,
				hasAudio: params.hasAudio,
			}),
		);

		return {
			steps,
			tools,
			weightMs,
			heavy: weightMs >= params.threshold,
			interim,
		};
	} catch (err) {
		console.warn("[TurnPlanner] プラン立案に失敗しました（無視）:", err);
		return null;
	}
}

/** デフォルトの一時応答（プランが interim を返さなかった場合）。 */
export const DEFAULT_INTERIM_TEXT =
	"承知しました。少し時間がかかりそうなので、処理を進めて完了したらこのチャンネルでお知らせします。少々お待ちください。";

/** 実行時に重い処理を検知した際の一時応答（プラン予測が外れたケースの実行時エスカレーション）。 */
export const RUNTIME_INTERIM_TEXT =
	"思ったより時間がかかっています。引き続き処理を進め、完了したらお知らせしますので少々お待ちください。";
