import { config } from "../config.js";
import { insertSynapse, updateSynapseEmbedding } from "../db/synapseRepo.js";
import { containsSecretValue } from "../utils/secretGuard.js";
import { generateAuxText } from "./llmClient.js";
import type { SynapseScope } from "./synapseEngine.js";
import { indexSynapse, isSynapseEngineEnabled } from "./synapseEngine.js";

// シナプス content の最大長（トークン肥大を避ける）
const MAX_CONTENT_LEN = 300;

// 抽出対象から除外する最小文字数（trim 後）
const MIN_USER_TEXT_LEN = 8;

/**
 * 秘匿値ガード（architecture §9.3 不変条件）。
 * 認証情報・トークン類を含むユーザー発話からはシナプスを一切作らない。
 */
const SECRET_GUARD_RE =
	/password|passwd|パスワード|secret|シークレット|token|api[_-]?key|credential|暗証|ワンタイム|otp/i;

/**
 * 「記憶に値する」発話を判定する軽量ヒューリスティック。
 * 嗜好・事実・制約のマーカー、または十分に長い発話を memorable とみなす。
 */
const MEMORABLE_RE =
	/好き|嫌い|いつも|毎週|毎日|苦手|アレルギー|誕生日|締め切り|目標|である|です|だ|設定|覚え/;

/** 純粋なコマンドっぽい入力（先頭が記号トリガ）を雑に判定する */
function looksLikeCommand(text: string): boolean {
	return /^[!/.\\$#＠@]/.test(text.trim());
}

/** content の正規化（前後空白除去 + 長さ上限） */
function capContent(text: string): string {
	const trimmed = text.trim().replace(/\s+/g, " ");
	return trimmed.length > MAX_CONTENT_LEN
		? trimmed.slice(0, MAX_CONTENT_LEN)
		: trimmed;
}

/**
 * ヒューリスティックなトピック語抽出（粗くてよい / null 許容）。
 * 最も長い「名詞っぽい」トークンを拾うだけ。見つからなければ null。
 */
function deriveTopicId(text: string): string | null {
	const tokens = text
		.split(/[\s、。．,.!?！？「」『』()（）[\]【】]+/)
		.map((t) => t.trim())
		.filter((t) => t.length >= 2 && !/^[ぁ-ん]+$/.test(t));
	if (tokens.length === 0) return null;
	let longest = tokens[0];
	for (const t of tokens) {
		if (t.length > longest.length) longest = t;
	}
	const topic = longest.slice(0, 32);
	return topic.length >= 2 ? topic : null;
}

/**
 * LLM 抽出モード。1 文の記憶断片と短いトピック語、または "NONE" を返させる。
 * 失敗・NONE・空・秘匿一致時は null。
 */
async function extractViaLlm(
	scope: SynapseScope,
	userText: string,
): Promise<{ content: string; topicId: string | null } | null> {
	const systemInstruction =
		"あなたは会話から長期記憶すべき情報を1件だけ抽出するアシスタントです。" +
		"ユーザーの恒久的な嗜好・事実・制約（好み、習慣、所属、期限、目標など）を1文で簡潔に要約してください。" +
		"認証情報・パスワード・トークン・暗証番号など秘匿情報は絶対に含めないでください。" +
		"記憶に値する情報が無ければ、必ず NONE とだけ出力してください。" +
		"出力形式は1行目に記憶断片、2行目に短いトピック語（任意、無ければ空行）。";
	const prompt =
		`次の会話ターンから、長期記憶すべき情報を抽出してください。\n` +
		`ユーザー発話: ${userText}\n` +
		`記憶に値しなければ NONE と出力してください。`;

	const raw = await generateAuxText(scope.userId, prompt, systemInstruction);
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed || /^NONE\b/i.test(trimmed)) return null;

	const lines = trimmed
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return null;
	const content = capContent(lines[0]);
	if (!content || SECRET_GUARD_RE.test(content)) return null;
	const topicId = lines[1] ? lines[1].slice(0, 32) : null;
	return { content, topicId };
}

/**
 * 会話ターンからシナプス（記憶の断片）を抽出し、SQLite へ永続化 + Rust 索引へ登録する。
 * バックグラウンド実行（呼び出し側は await しない / 投げない）。機能フラグ config.synapseExtractionEnabled で OFF 可。
 */
export async function maybeExtractSynapse(args: {
	scope: SynapseScope;
	userText: string;
	assistantText: string;
	sourceMsgId?: number | null;
}): Promise<void> {
	try {
		// 既定 OFF。機能フラグで無効時は即時 return。
		if (config.synapseExtractionEnabled !== true) return;
		// 索引先のエンジンが無ければ抽出しても意味がない。
		if (!isSynapseEngineEnabled()) return;

		const userText = args.userText ?? "";
		const trimmed = userText.trim();

		// 秘匿除外不変条件（§9.3）: 認証情報を含む発話は記憶しない。
		// (1) キーワードベース（password / token 等のラベルを伴う発話）
		if (SECRET_GUARD_RE.test(userText)) return;
		// (2) 値の形状ベース（トリガ語を伴わず貼り付けられた JWT・APIキー・鍵等の高エントロピートークン）
		if (containsSecretValue(userText)) return;
		// 短すぎ / コマンドっぽい入力はスキップ。
		if (trimmed.length < MIN_USER_TEXT_LEN) return;
		if (looksLikeCommand(trimmed)) return;

		let content: string | null = null;
		let topicId: string | null = null;

		if (config.synapseExtractLlm === true) {
			// LLM モード
			const extracted = await extractViaLlm(args.scope, userText);
			if (!extracted) return;
			content = extracted.content;
			topicId = extracted.topicId;
		} else {
			// 既定ヒューリスティック（LLM コストゼロ）
			const isMemorable = MEMORABLE_RE.test(trimmed) || trimmed.length > 30;
			if (!isMemorable) return;
			content = capContent(userText);
			topicId = deriveTopicId(trimmed);
		}

		if (!content) return;
		// 念のため content 側もキーワード・値形状の双方で秘匿ガードを通す。
		if (SECRET_GUARD_RE.test(content)) return;
		if (containsSecretValue(content)) return;

		// 形成時の時刻文脈（再ランキング専用）。現地時刻の時間帯・曜日を記録する。
		// 意味埋め込みには混ぜない。SYNAPSE_TIME_BIAS_WEIGHT=0 のとき想起では未使用。
		const now = new Date();
		const ctxTod = now.getHours(); // 0-23
		const ctxDow = now.getDay(); // 0=日〜6=土

		// 永続化（Node が SQLite の唯一の書き手）。
		const id = insertSynapse({
			scope: args.scope,
			content,
			topicId,
			sourceMsgId: args.sourceMsgId ?? null,
			ctxTod,
			ctxDow,
		});

		// RAM 索引へ登録し、埋め込み(base64)を受け取って永続化する。
		// エンジンが落ちていれば null（行は埋め込みなしで残る → 将来の reindex で補完）。
		const indexed = await indexSynapse(id, args.scope, topicId, content, {
			ctxTod,
			ctxDow,
		});
		if (indexed) {
			const buffer = Buffer.from(indexed.embeddingB64, "base64");
			updateSynapseEmbedding(id, buffer, indexed.modelVersion);
		}
	} catch (err) {
		// 常にバックグラウンド実行。呼び出し側へ投げない。
		console.warn(
			"⚠️ [Synapse] シナプス抽出に失敗しました（無視）:",
			err instanceof Error ? err.message : err,
		);
	}
}
