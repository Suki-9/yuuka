import { redactSecretsInText } from "./secretGuard.js";

// ─── ツール呼び出し引数のサニタイズ（§6.3.2: 認証情報をログ/永続化に残さない） ───────
//
// gemini.ts の Function Calling ループから分離した秘匿マスク専用ユーティリティ。
// 振る舞いは変えず、責務（ログ/永続化向けの引数サニタイズ）を独立モジュールへ切り出す。

/** 引数に秘匿値を含み得るFunction（引数ログ自体を抑止する） */
const SECRET_ARG_FUNCTIONS = new Set(["addCredential", "updateCredential"]);

/** 秘匿すべき引数キーのパターン */
const SECRET_KEY_PATTERN = /password|secret|token|api_?key|credential/i;

/**
 * コンソールログ用に Function Call 引数をサニタイズする。
 * 認証情報系Functionは引数全体を伏せ、その他も秘匿キー名の値をマスクする。
 */
export function sanitizeArgsForLog(
	name: string,
	args: Record<string, unknown>,
): string {
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
 * 自由入力テキストを引数に持つツール（値そのものに認証情報がタイプされ得る）。
 * これらは値が秘匿キー名でなくても永続化前に伏せる必要がある（§9.3）。
 */
const FREE_TEXT_INPUT_TOOLS = new Set(["browserInteractiveType"]);

/**
 * tool_outcomes.args_digest 用の引数ダイジェスト（永続化＝ログより強い秘匿要件）。
 * sanitizeArgsForLog（キー名マスク＋認証系Function全伏せ）に加え、
 *   1) 自由入力系ツールの text 値を構造的に伏せ（タイプされた認証情報を弾く）、
 *   2) 値の「形状」から秘匿らしいトークン（JWT/APIキー/鍵等）を伏字化する（§9.3 多層防御）。
 */
export function buildOutcomeArgsDigest(
	name: string,
	args: Record<string, unknown>,
): string {
	let safeArgs = args;
	if (FREE_TEXT_INPUT_TOOLS.has(name) && typeof args.text === "string") {
		safeArgs = { ...args, text: `(入力値:${args.text.length}文字)` };
	}
	return redactSecretsInText(sanitizeArgsForLog(name, safeArgs));
}
