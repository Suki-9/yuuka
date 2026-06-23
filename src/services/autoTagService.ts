import { getTodoById, listAllTags, updateTodoTags } from "../db/todoRepo.js";
import { generateAuxText, getUserGenAI } from "./llmClient.js";

// ─── タグ自動付与サービス（§3.2.4） ──────────────────────────────────────────
//
// ToDo の追加・更新後にバックグラウンドで LLM がタグ（1〜3個）を自動付与する。
// - 既存タスクから学習した語彙（listAllTags）を優先し、必要に応じて新規語彙を追加する
// - ユーザーへの応答をブロックしない（呼び出し側は await しないこと）
// - Gemini APIキー未設定時は静かにスキップ。LLM応答不正・例外時も握りつぶしてログのみ

/** 付与するタグの最大数 */
const MAX_TAGS = 3;

/** 1タグの最大文字数（異常に長い生成結果を弾く） */
const MAX_TAG_LENGTH = 20;

/** プロンプトに含める既存タグ語彙の最大数 */
const MAX_VOCAB_IN_PROMPT = 30;

const SYSTEM_INSTRUCTION =
	"あなたはToDo管理システムのタグ付けエンジンです。指示されたToDoに最適なタグをJSON配列のみで出力します。説明文・前置き・コードフェンスは一切出力しません。";

/**
 * LLM応答からタグのJSON配列を堅牢に抽出する。
 * コードフェンス（```json ... ```）や前後の説明文が混ざっていても、
 * 最初の '[' から最後の ']' までを切り出してパースを試みる。
 */
export function parseTagArray(text: string): string[] {
	let cleaned = text.trim();
	// コードフェンス除去（```json / ``` のいずれにも対応）
	cleaned = cleaned
		.replace(/^```[a-zA-Z]*\s*/m, "")
		.replace(/```\s*$/m, "")
		.trim();

	const start = cleaned.indexOf("[");
	const end = cleaned.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const tags = parsed
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH);

	// 重複除去のうえ最大数に制限
	return [...new Set(tags)].slice(0, MAX_TAGS);
}

/** タグ生成プロンプトを組み立てる */
function buildPrompt(
	todo: { title: string; description: string | null; due_date: string | null },
	vocab: { tag: string; count: number }[],
): string {
	const vocabSection =
		vocab.length > 0
			? vocab
					.slice(0, MAX_VOCAB_IN_PROMPT)
					.map((v) => `- ${v.tag} (${v.count}件)`)
					.join("\n")
			: "（まだタグはありません。タスク内容から適切な新しいタグを作成してください）";

	return `以下のToDoタスクに付与するタグを1〜${MAX_TAGS}個生成してください。

## ルール
- タグは日本語の短い単語（例: 業務, 開発, 買い物, 支払い, 学習, 日常, 締め切り間近）
- 既存タグ語彙の中に適切なものがあれば優先的に再利用する（表記ゆれを作らない）
- 適切な既存タグが無い場合のみ新しいタグを作成する
- 出力はJSON配列のみ（例: ["業務", "開発"]）。説明文やコードフェンスは付けない

## 既存タグ語彙（使用回数順）
${vocabSection}

## 対象ToDo
タイトル: ${todo.title}
説明: ${todo.description ?? "（なし）"}
期限: ${todo.due_date ?? "（なし）"}`;
}

/** タグ自動付与の本体処理（scheduleAutoTagging から非同期に呼ばれる） */
async function runAutoTagging(
	userId: string,
	botId: string,
	todoId: number,
): Promise<void> {
	// APIキー未設定なら静かにスキップ（§3.2.4: タグ付与は補助機能でありエラー扱いしない）
	if (!getUserGenAI(userId)) return;

	// 対象取得（処理開始までに削除されている可能性があるため再取得する）
	const todo = getTodoById(userId, botId, todoId);
	if (!todo) return;

	// 既存タグ語彙を学習素材としてプロンプトに含める（§3.2.4: 既存語彙を優先）
	const vocab = listAllTags(userId, botId);
	const prompt = buildPrompt(todo, vocab);

	const response = await generateAuxText(userId, prompt, SYSTEM_INSTRUCTION);
	if (!response) {
		console.warn(
			`⚠️ タグ自動付与: LLM応答を取得できませんでした (user: ${userId}, todo: #${todoId})`,
		);
		return;
	}

	const tags = parseTagArray(response);
	if (tags.length === 0) {
		console.warn(
			`⚠️ タグ自動付与: LLM応答からタグを抽出できませんでした (todo: #${todoId}): ${response.slice(0, 100)}`,
		);
		return;
	}

	// 生成中にユーザーが手動でタグを変えていた場合も、最新のLLM判断で上書き保存する（§3.2.4: 追加・更新のたびに付与）
	updateTodoTags(userId, botId, todoId, tags);
	console.log(`🏷️ タグ自動付与完了 (todo: #${todoId}): ${tags.join(", ")}`);
}

/**
 * タグ自動付与をバックグラウンドで起動する（§3.2.4: ユーザーへの応答をブロックしない）。
 * 呼び出し側（todoFunctions）は await せずに呼ぶこと。エラーは全てここで握りつぶしログのみ残す。
 */
export function scheduleAutoTagging(
	userId: string,
	botId: string,
	todoId: number,
): void {
	setImmediate(() => {
		runAutoTagging(userId, botId, todoId).catch((err) => {
			console.error(
				`⚠️ タグ自動付与に失敗しました (user: ${userId}, todo: #${todoId}):`,
				err,
			);
		});
	});
}
