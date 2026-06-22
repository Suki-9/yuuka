import { GoogleGenerativeAI } from "@google/generative-ai";
import { getUserGeminiConfig } from "../db/userRepo.js";
import { getBotById } from "../db/botRepo.js";
import { decryptText } from "../utils/crypto.js";

// ユーザー別 GoogleGenerativeAI インスタンスキャッシュ
const userAICache = new Map<
	string,
	{ genAI: GoogleGenerativeAI; apiKey: string }
>();

// Bot別 GoogleGenerativeAI インスタンスキャッシュ（Bot専用キー実行用）
const botAICache = new Map<
	string,
	{ genAI: GoogleGenerativeAI; apiKey: string }
>();

/** Bot専用キーで使用する既定モデル（Bot単位のモデル設定はPhase 2課題） */
const BOT_DEFAULT_MODEL = "gemini-3.1-flash-lite";

/**
 * ユーザー自身の Gemini API キーから GenAI インスタンスを取得する。
 * 仕様§4.2: APIキーはユーザー毎に個別設定・共有不可（Bot単位キーは廃止）。
 */
export function getUserGenAI(
	userId: string,
): { genAI: GoogleGenerativeAI; model: string } | null {
	const conf = getUserGeminiConfig(userId);
	if (!conf || !conf.apiKeyEncrypted || !conf.apiKeyIv || !conf.apiKeyTag) {
		return null;
	}

	let apiKey: string;
	try {
		apiKey = decryptText(conf.apiKeyEncrypted, conf.apiKeyIv, conf.apiKeyTag);
	} catch (err) {
		console.error(
			`ユーザー ${userId} のGemini API Keyの復号に失敗しました:`,
			err,
		);
		return null;
	}

	const cached = userAICache.get(userId);
	if (cached && cached.apiKey === apiKey) {
		return {
			genAI: cached.genAI,
			model: conf.model || "gemini-3.1-flash-lite",
		};
	}

	const genAI = new GoogleGenerativeAI(apiKey);
	userAICache.set(userId, { genAI, apiKey });
	return { genAI, model: conf.model || "gemini-3.1-flash-lite" };
}

/**
 * Bot専用の Gemini API キーから GenAI インスタンスを取得する。
 * bot_attributes_requirements.md §4.3.3: 汎用モードはBot専用キーで実行し、
 * 発話ユーザーが登録済みユーザーであっても本人キーは使用しない。
 * キー未設定・復号失敗時は null（呼び出し側は応答せず管理UIに警告を出す）。
 */
export function getBotGenAI(
	botId: string,
): { genAI: GoogleGenerativeAI; model: string } | null {
	const bot = getBotById(botId);
	if (
		!bot ||
		!bot.gemini_api_key_encrypted ||
		!bot.gemini_api_key_iv ||
		!bot.gemini_api_key_tag
	) {
		return null;
	}

	let apiKey: string;
	try {
		apiKey = decryptText(
			bot.gemini_api_key_encrypted,
			bot.gemini_api_key_iv,
			bot.gemini_api_key_tag,
		);
	} catch (err) {
		console.error(`Bot ${botId} のGemini API Keyの復号に失敗しました:`, err);
		return null;
	}

	const cached = botAICache.get(botId);
	if (cached && cached.apiKey === apiKey) {
		return { genAI: cached.genAI, model: BOT_DEFAULT_MODEL };
	}

	const genAI = new GoogleGenerativeAI(apiKey);
	botAICache.set(botId, { genAI, apiKey });
	return { genAI, model: BOT_DEFAULT_MODEL };
}

/** レート制限・一時サーバーエラー判定 */
function isRetryableError(error: unknown): boolean {
	if (error && typeof error === "object" && "status" in error) {
		const status = (error as { status: number }).status;
		return (
			status === 429 ||
			status === 500 ||
			status === 502 ||
			status === 503 ||
			status === 504
		);
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 補助的なテキスト生成（Function Callなし・リトライ付き）。
 * 用途: タグ自動付与・Webhookペイロード解釈・日報/週報サマリ・ニュース要約など。
 * ユーザーのAPIキーが未設定の場合は null を返す（呼び出し側でフォールバックすること）。
 */
export async function generateAuxText(
	userId: string,
	prompt: string,
	systemInstruction?: string,
	maxRetries: number = 2,
): Promise<string | null> {
	const ai = getUserGenAI(userId);
	if (!ai) return null;

	const model = ai.genAI.getGenerativeModel(
		{
			model: ai.model,
			...(systemInstruction ? { systemInstruction } : {}),
		},
		// 応答が返らない場合に cron ティック等が永久に待たされないようにする
		{ timeout: 60_000 },
	);

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const result = await model.generateContent(prompt);
			return result.response.text();
		} catch (error) {
			if (isRetryableError(error) && attempt < maxRetries) {
				const waitMs = Math.min(1000 * Math.pow(2, attempt + 1), 30000);
				console.log(
					`⏳ 補助生成リトライ (${attempt + 1}/${maxRetries})、${Math.ceil(waitMs / 1000)}秒後...`,
				);
				await sleep(waitMs);
				continue;
			}
			console.error(`補助テキスト生成に失敗しました (user: ${userId}):`, error);
			return null;
		}
	}
	return null;
}

/**
 * 補助的なマルチモーダル生成（音声文字起こし・画像解析等、Function Callなし）。
 */
export async function generateAuxMultimodal(
	userId: string,
	prompt: string,
	inlineData: { data: string; mimeType: string },
	maxRetries: number = 2,
): Promise<string | null> {
	const ai = getUserGenAI(userId);
	if (!ai) return null;

	const model = ai.genAI.getGenerativeModel(
		{ model: ai.model },
		{ timeout: 120_000 },
	);

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const result = await model.generateContent([
				{ inlineData },
				{ text: prompt },
			]);
			return result.response.text();
		} catch (error) {
			if (isRetryableError(error) && attempt < maxRetries) {
				const waitMs = Math.min(1000 * Math.pow(2, attempt + 1), 30000);
				await sleep(waitMs);
				continue;
			}
			console.error(
				`マルチモーダル補助生成に失敗しました (user: ${userId}):`,
				error,
			);
			return null;
		}
	}
	return null;
}
