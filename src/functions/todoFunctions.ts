import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { CronExpressionParser } from "cron-parser";
import { config } from "../config.js";
import * as todoRepo from "../db/todoRepo.js";
import {
	parseTodoTags,
	type TodoPriority,
	type TodoRecord,
	type TodoWithSubtasks,
} from "../db/todoRepo.js";
import { scheduleAutoTagging } from "../services/autoTagService.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { formatDateTime } from "../utils/formatters.js";

// ─── ToDo・タグ管理・優先度整理 Function 群（§3.2） ──────────────────────────
//
// 旧 taskFunctions.ts の置き換え。全データは ctx.userId（DiscordユーザーID）でスコープする。
// タグ自動付与（§3.2.4）は autoTagService がバックグラウンドで行い、応答をブロックしない。
// 優先度整理（§3.2.3）は organizeTaskPriorities（提案用データ取得）→ ユーザー承認 →
// applyTaskPriorities（一括確定）の2段階方式とする。

// ─── タスクの使い方ガイド（§3.2: 公開ガイドページ /tasks/guide と同一内容のMD版） ──
//
// LLMが「タスクの使い方」を聞かれた時に getTaskUsageGuide で取得して案内する。
// 内容は src/public/index.html の #task-guide-overlay と対応させる（更新時は両方を直す）。

/** 使い方ガイドページのURL（BASE_URL 未設定時は相対パス） */
function taskGuideUrl(): string {
	const base = config.baseUrl ? config.baseUrl.replace(/\/$/, "") : "";
	return `${base}/tasks/guide`;
}

/** タスクの使い方ガイド本文（Markdown） */
const TASK_USAGE_GUIDE_MD = `## タスク管理の使い方

### 1. タスクの基本
「やること」を登録して、期限・優先度・進捗とともに管理できます。「〇〇をタスクに追加して」で登録、「〇〇終わった」で完了にできます。
- **期限・開始日**: 期限と開始日を設定でき、両方あるタスクはガントチャートにバーで表示されます。
- **優先度**: 🔴高 / 🟡中 / 🔵低。「タスクを整理して」でAIが優先度を提案します（確定は承認後）。
- **いつかやる**: 期限も開始日も決めていないタスクは「🕗 いつかやる」にまとまります。

### 2. サブタスクと進捗
- **サブタスク**: 大きなタスクを小さな手順に分解できます（1段まで）。親の進捗は「完了サブタスク数 ÷ 全体」で自動計算。
- **進捗**: サブタスクのないタスクは 0〜100% で更新でき、メモとともに履歴に残ります。

### 3. タグでグループ分け
- **自動タグ付け**: 追加・更新時に内容からAIが自動でタグを付けます。
- **手動修正**: 「#3のタグを『買い物』に変えて」「『緊急』タグを足して」「『仮』タグを外して」のように直せます。
- **グループ表示**: 「タスクをグループ別に見せて」でタグごとに確認できます（タグ無しは「未分類」）。

### 4. ルーチン（繰り返し）タスク
「毎週月曜の朝に〇〇」のように伝えると繰り返しタスクとして登録され、期日が来ると自動で次回ぶんへ更新されます。
- **終わり方を決めて登録**: 「年末まで毎週」（終了日）や「毎日5回だけ」（回数）を指定すると自動で止まります。
- **あとから終了**: 「もう毎週の〇〇はやらなくていい」で繰り返しを終了（タスク自体は単発として残ります）。
- **リマインド**: 期限が近づくと自動でDM／チャンネルに通知されます。

### 5. 表示モード
- **一覧**: 優先度・期限順。「全て / 未完了 / 完了済み」で絞り込み。
- **ガント**: 開始日〜期限をバーで時系列表示。`;

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** Function Call の引数から空でない文字列を取り出す（無ければ undefined） */
function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Function 応答（失敗）のJSON整形。message のみの定型エラー */
function fail(message: string): string {
	return JSON.stringify({ success: false, message });
}

/** Function 応答（成功）のJSON整形。message ＋任意の追加フィールド（順序は message が先） */
function ok(message: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ success: true, message, ...extra });
}

/** Function Call 引数を数値ID（数値でなければ NaN）として取り出す */
function asTodoId(value: unknown): number {
	return typeof value === "number" ? value : NaN;
}

/** タグ配列を正規化する（文字列化・trim・空除去・重複除去、最大8件） */
function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of value) {
		if (typeof raw !== "string") continue;
		const tag = raw.trim();
		if (tag.length === 0 || seen.has(tag)) continue;
		seen.add(tag);
		result.push(tag);
		if (result.length >= 8) break;
	}
	return result;
}

/** cron式の妥当性を検証する（パースできれば true） */
function isValidCron(rule: string): boolean {
	try {
		CronExpressionParser.parse(rule, { currentDate: new Date() });
		return true;
	} catch {
		return false;
	}
}

/** ルーチン情報の表示ラベル（繰り返しでなければ空文字） */
function routineLabel(
	todo: Pick<TodoRecord, "repeat_rule" | "repeat_count">,
): string {
	if (!todo.repeat_rule) return "";
	const countPart =
		todo.repeat_count !== null ? `・残り${todo.repeat_count}回` : "";
	return ` 🔁ルーチン(${todo.repeat_rule}${countPart})`;
}

/** 優先度引数の検証（high/medium/low 以外は undefined） */
function asOptionalPriority(value: unknown): TodoPriority | undefined {
	if (value === "high" || value === "medium" || value === "low") return value;
	return undefined;
}

/** 優先度の表示ラベル */
function priorityLabel(priority: TodoPriority | null): string {
	switch (priority) {
		case "high":
			return "🔴 高";
		case "medium":
			return "🟡 中";
		case "low":
			return "🔵 低";
		default:
			return "⚪ 未設定";
	}
}

/** ステータスの表示絵文字 */
function statusEmoji(status: string): string {
	return status === "done" ? "✅" : "⬜";
}

/** 期限表示（日時/日付混在のISO文字列を読みやすく） */
function dueLabel(dueDate: string | null): string {
	if (!dueDate) return "";
	// 日付のみ（YYYY-MM-DD）はそのまま、日時はフォーマットして表示
	const formatted =
		dueDate.includes("T") || dueDate.includes(" ")
			? formatDateTime(dueDate)
			: dueDate;
	return ` (期限: ${formatted})`;
}

/** LLMへ返すToDoの共通整形（id/タイトル/期限/開始日/進捗/優先度/タグを含める） */
function toTodoEntry(todo: TodoRecord) {
	return {
		todo_id: todo.id,
		title: todo.title,
		description: todo.description,
		due_date: todo.due_date,
		start_date: todo.start_date,
		priority: todo.priority,
		tags: parseTodoTags(todo),
		status: todo.status,
		progress: todo.progress,
		parent_id: todo.parent_id,
		repeat_rule: todo.repeat_rule,
		repeat_until: todo.repeat_until,
		repeat_count: todo.repeat_count,
	};
}

/** 親タスク＋サブタスク＋算出進捗のLLM向け整形 */
function toTodoTreeEntry(todo: TodoWithSubtasks) {
	return {
		...toTodoEntry(todo),
		effective_progress: todo.effective_progress,
		subtasks: todo.subtasks.map(toTodoEntry),
	};
}

/** 進捗の表示（子があれば算出値、無ければ手動値） */
function progressLabel(percent: number): string {
	return `📊 ${percent}%`;
}

/** 一覧の1行表示（メッセージ用。親タスクはサブタスク行を字下げで続ける） */
function todoTreeLines(todo: TodoWithSubtasks): string {
	const tags = parseTodoTags(todo);
	const tagLabel = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
	const subInfo =
		todo.subtasks.length > 0
			? ` (サブタスク ${todo.subtasks.filter((s) => s.status === "done").length}/${todo.subtasks.length})`
			: "";
	const head = `${statusEmoji(todo.status)} #${todo.id} ${todo.title}${dueLabel(todo.due_date)} ${priorityLabel(todo.priority)} ${progressLabel(todo.effective_progress)}${subInfo}${tagLabel}${routineLabel(todo)}`;
	const subLines = todo.subtasks.map(
		(s) =>
			`    ↳ ${statusEmoji(s.status)} #${s.id} ${s.title}${dueLabel(s.due_date)} ${progressLabel(s.status === "done" ? 100 : s.progress)}`,
	);
	return [head, ...subLines].join("\n");
}

// ─── Function Declarations ───────────────────────────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "addTodo",
		description:
			"新しいタスク（やること）をToDoリストに1件追加する。\n" +
			"・例:「〜をやることに追加して」「〜しなきゃ」などの登録依頼で呼ぶ。\n" +
			"・タグは追加後に自動で付くので指定しなくてよい。\n" +
			"・優先度はユーザーがはっきり言った時だけ指定する（言わなければ省略）。\n" +
			"・「毎週」「毎月」など繰り返す“ルーチン”にしたい時は repeat_rule を入れる。その場合 due_date に初回の期日も必ず入れる。\n" +
			"・あるタスクの中の「サブタスク」として登録したい時 → 代わりに addSubtask を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				title: {
					type: SchemaType.STRING,
					description: "タスクのタイトル（短い体言止めがおすすめ）",
				},
				description: {
					type: SchemaType.STRING,
					description: "タスクの詳しい説明（任意）",
				},
				due_date: {
					type: SchemaType.STRING,
					description:
						"締め切り。形式: 日付だけなら YYYY-MM-DD、時刻ありなら YYYY-MM-DDTHH:MM:SS。「明日まで」などは今の日時を基準に変換して入れる。ルーチン(repeat_rule)を指定する時は初回の期日として必須（任意）",
				},
				start_date: {
					type: SchemaType.STRING,
					description:
						"始める日。形式: YYYY-MM-DD または YYYY-MM-DDTHH:MM:SS。ガントチャートのバーの始まりになる。「来週から始める」など着手予定がある時に入れる（任意）",
				},
				priority: {
					type: SchemaType.STRING,
					description:
						"優先度: 'high'（高）| 'medium'（中）| 'low'（低）。ユーザーがはっきり言った時だけ指定（任意）",
				},
				repeat_rule: {
					type: SchemaType.STRING,
					description:
						"ルーチン（繰り返し）にする時の周期。cron式で書く（並びは 分 時 日 月 曜日。例 '0 9 * * 1'=毎週月曜、'0 0 1 * *'=毎月1日、'0 0 * * *'=毎日）。繰り返さない単発タスクでは指定しない（任意）",
				},
				repeat_until: {
					type: SchemaType.STRING,
					description:
						"ルーチンの終了日 YYYY-MM-DD。「年末まで毎週」のように終わりが決まっている時に入れる。次回期日がこの日を越えたら自動で繰り返しを止める（任意）",
				},
				repeat_count: {
					type: SchemaType.NUMBER,
					description:
						"ルーチンを何回行うか（初回を含む回数）。「毎日5回だけ」のように回数で終える時に入れる。指定回数に達したら自動で止まる（任意）",
				},
			},
			required: ["title"],
		},
	},
	{
		name: "addSubtask",
		description:
			"あるタスクの中の小さな手順（サブタスク）を1件追加する。\n" +
			"・例:「#3のサブタスクに〜を追加」「○○タスクの中に△△という手順を入れて」のように、タスクを分解した小タスクを登録する依頼で呼ぶ。\n" +
			"・親タスクの進捗は『完了したサブタスク数 ÷ 全サブタスク数』で自動計算される。\n" +
			"・サブタスクの下にさらにサブタスクは作れない（1段までしか入れ子にできない）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				parent_todo_id: {
					type: SchemaType.NUMBER,
					description: "どのタスクの下に入れるか。親タスクのID（#番号）",
				},
				title: {
					type: SchemaType.STRING,
					description: "サブタスクのタイトル（短い体言止めがおすすめ）",
				},
				description: {
					type: SchemaType.STRING,
					description: "サブタスクの詳しい説明（任意）",
				},
				due_date: {
					type: SchemaType.STRING,
					description:
						"サブタスクの締め切り。形式: YYYY-MM-DD または YYYY-MM-DDTHH:MM:SS（任意）",
				},
				start_date: {
					type: SchemaType.STRING,
					description:
						"サブタスクを始める日。形式: YYYY-MM-DD または YYYY-MM-DDTHH:MM:SS（任意）",
				},
			},
			required: ["parent_todo_id", "title"],
		},
	},
	{
		name: "listTodos",
		description:
			"タスクの一覧を取り出す。「タスク見せて」「業務タスクを見せて」などで呼ぶ。\n" +
			"・tag を指定するとそのタグ（グループ）のタスクだけに絞れる。タグ名が分からない時は先に listTodoTags で確認する。\n" +
			"・結果は親タスクごとに、サブタスク（subtasks）と計算後の進捗（effective_progress）が入れ子で入る。\n" +
			"・タグごとにまとめる、進捗やサブタスクの達成度に触れるなど、ユーザーが見やすい形に整えて見せる。\n" +
			"・1つのタスクのサブタスク詳細や進捗の履歴が知りたい時 → 代わりに getTaskDetail を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				status: {
					type: SchemaType.STRING,
					description:
						"絞り込む状態: 'open'（未完了）| 'done'（完了済み）| 'all'（すべて）。省略='open'",
				},
				tag: {
					type: SchemaType.STRING,
					description:
						"絞り込むタグ名（例: '業務', '買い物'）。そのタグが付いたタスクだけ返す（任意）",
				},
			},
		},
	},
	{
		name: "completeTodo",
		description:
			"タスクを完了（done）にする。\n" +
			"・例:「〜終わった」「#3完了にして」などの報告で呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "完了にするタスクのID（#番号）",
				},
			},
			required: ["todo_id"],
		},
	},
	{
		name: "deleteTodo",
		description:
			"タスクをリストから削除する（消すと元に戻せない）。\n" +
			"・終わったのではなく、取り消したい・もう不要になった時に呼ぶ。\n" +
			"・終わった報告の時 → 代わりに completeTodo を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "削除するタスクのID（#番号）",
				},
			},
			required: ["todo_id"],
		},
	},
	{
		name: "updateTodo",
		description:
			"既にあるタスクの中身を変える（タイトル・説明・締め切り・開始日・優先度・状態）。\n" +
			"・例:「#2の期限を金曜にして」などの依頼で呼ぶ。\n" +
			"・変える項目だけを指定する。\n" +
			"・タイトルや説明を変えると、タグは自動で付け直される。\n" +
			"・進捗（何%まで進んだか）を変えたい時 → 代わりに updateTaskProgress を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "変えるタスクのID（#番号）",
				},
				title: {
					type: SchemaType.STRING,
					description: "新しいタイトル（任意）",
				},
				description: {
					type: SchemaType.STRING,
					description: "新しい説明文（任意）",
				},
				due_date: {
					type: SchemaType.STRING,
					description:
						"新しい締め切り。形式: YYYY-MM-DD または YYYY-MM-DDTHH:MM:SS。空文字を渡すと締め切りを消す（任意）",
				},
				start_date: {
					type: SchemaType.STRING,
					description:
						"新しい開始日。形式: YYYY-MM-DD または YYYY-MM-DDTHH:MM:SS。空文字を渡すと開始日を消す（任意）",
				},
				priority: {
					type: SchemaType.STRING,
					description:
						"新しい優先度: 'high'（高）| 'medium'（中）| 'low'（低）（任意）",
				},
				status: {
					type: SchemaType.STRING,
					description:
						"新しい状態: 'open'（未完了に戻す）| 'done'（完了）（任意）",
				},
			},
			required: ["todo_id"],
		},
	},
	{
		name: "updateTaskProgress",
		description:
			"タスクの進み具合（0〜100%）を更新し、メモを履歴に残す。\n" +
			"・例:「○○は半分終わった」「設計が終わったので60%くらい」など、どこまで進んだかの報告で呼ぶ。\n" +
			"・100にすると自動で完了になる。\n" +
			"・note に『何が終わったか』を短く書くと、後から経緯を見返せる。\n" +
			"・サブタスクを持つ親タスクは進捗が『完了サブタスク数÷全体』で自動計算されるため、ここでは更新できない。その時は中のサブタスクを完了/進捗更新する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "進捗を更新するタスクのID（#番号）",
				},
				progress: {
					type: SchemaType.NUMBER,
					description: "進み具合 0〜100の整数（%）。100にすると完了扱い",
				},
				note: {
					type: SchemaType.STRING,
					description:
						"進捗メモ（例: '設計フェーズ完了、実装着手'）。履歴に残る（任意）",
				},
			},
			required: ["todo_id", "progress"],
		},
	},
	{
		name: "getTaskDetail",
		description:
			"1つのタスクの詳しい中身を取り出す（サブタスク一覧・計算後の進捗・進捗の更新履歴）。\n" +
			"・例:「#3の進捗の経緯を見せて」「○○タスクの中身を詳しく」などの依頼で呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "詳しく見るタスクのID（#番号）",
				},
			},
			required: ["todo_id"],
		},
	},
	{
		name: "listTodoTags",
		description:
			"未完了タスクに付いているタグの一覧と、それぞれの件数を取り出す。\n" +
			"・例:「どんなタグがある？」「タスクをグループごとに見せて」などの依頼で呼ぶ。\n" +
			"・listTodos でタグ絞り込みに使うタグ名を確かめたい時にも使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "editTodoTags",
		description:
			"タスクに付いているタグ（グループ）を手動で直す。\n" +
			"・例:「#3のタグを『買い物』に変えて」「このタスクに『緊急』タグを足して」「『仮』タグを外して」などの依頼で呼ぶ。\n" +
			"・mode で操作を選ぶ: 'set'（指定タグで丸ごと置き換え）| 'add'（追加）| 'remove'（指定タグを外す）。省略時は 'set'。\n" +
			"・tags には対象のタグ名を配列で渡す（例: ['業務','緊急']）。\n" +
			"・注意: この後にタイトルや説明を updateTodo で変えると、タグは自動で付け直されて手動修正が上書きされることがある。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "タグを直すタスクのID（#番号）",
				},
				mode: {
					type: SchemaType.STRING,
					description:
						"操作: 'set'（置き換え）| 'add'（追加）| 'remove'（削除）。省略='set'",
				},
				tags: {
					type: SchemaType.ARRAY,
					description:
						"対象のタグ名の配列（例: ['業務','緊急']）。set では空配列でタグを全消去できる",
					items: { type: SchemaType.STRING },
				},
			},
			required: ["todo_id", "tags"],
		},
	},
	{
		name: "listTasksByTag",
		description:
			"タスクをタグ（グループ）ごとにまとめて取り出す。\n" +
			"・例:「タスクをグループ別に見せて」「タグごとにまとめて」などの依頼で呼ぶ。\n" +
			"・1つのタスクが複数タグを持つ場合は、それぞれのグループに現れる。\n" +
			"・タグの付いていないタスクは『未分類』グループにまとめて返す。\n" +
			"・特定の1タグだけ見たい時 → 代わりに listTodos の tag 引数を使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				status: {
					type: SchemaType.STRING,
					description:
						"絞り込む状態: 'open'（未完了）| 'done'（完了済み）| 'all'（すべて）。省略='open'",
				},
			},
		},
	},
	{
		name: "getTaskUsageGuide",
		description:
			"タスク管理機能の「使い方」を案内する。\n" +
			"・例:「タスクってどう使うの？」「タスクの使い方教えて」「ルーチンタスクのやり方は？」など、タスク機能の操作方法・説明を求められた時に呼ぶ。\n" +
			"・返ってくる guide_markdown（使い方本文）と guide_url（詳しい説明ページのリンク）を必ず両方ユーザーに伝える。\n" +
			"・本文はあなた自身の口調・人格（ペルソナ）に合わせて自然に言い換えて返すこと（要点は省略しない）。最後にページのリンクも案内する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "stopTodoRoutine",
		description:
			"ルーチン（繰り返し）タスクの繰り返しを終了する（終了指示）。\n" +
			"・例:「もう毎週の○○はやらなくていい」「#3のルーチンを止めて」などの依頼で呼ぶ。\n" +
			"・タスク自体は消えず、今ある1件は普通の単発タスクとして残る（完全に消したい時は deleteTodo）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				todo_id: {
					type: SchemaType.NUMBER,
					description: "繰り返しを止めるルーチンタスクのID（#番号）",
				},
			},
			required: ["todo_id"],
		},
	},
	{
		name: "organizeTaskPriorities",
		description:
			"優先度の整理の1段目。未完了タスク全部を、期限・タグ・今の優先度つきで取り出す。\n" +
			"・例:「タスクを整理して」「優先順位をつけて」と頼まれた時に呼ぶ。\n" +
			"・取り出した結果から、期限の近さ・タイトルや説明から分かる大事さ・タグを見て、各タスクの優先度（high/medium/low）を【提案】としてユーザーに見せ、OKをもらう。\n" +
			"・承認をもらってから applyTaskPriorities を呼んで確定する。提案だけにとどめ、勝手に確定しない。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "applyTaskPriorities",
		description:
			"優先度の整理の2段目（確定）。複数タスクの優先度をまとめて保存する。\n" +
			"・organizeTaskPriorities で出した提案を、ユーザーが承認した後だけ呼ぶ。\n" +
			"・ユーザーの承認がないうちは絶対に呼ばない。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				items: {
					type: SchemaType.ARRAY,
					description: "確定する優先度のリスト。承認された提案の内容とそろえる",
					items: {
						type: SchemaType.OBJECT,
						properties: {
							todo_id: {
								type: SchemaType.NUMBER,
								description: "対象タスクのID",
							},
							priority: {
								type: SchemaType.STRING,
								description:
									"確定する優先度: 'high'（高）| 'medium'（中）| 'low'（低）",
							},
						},
						required: ["todo_id", "priority"],
					},
				},
			},
			required: ["items"],
		},
	},
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const handlers: FunctionModule["handlers"] = {
	// ToDo追加（§3.2.1）。タグ自動付与はバックグラウンド起動し応答をブロックしない（§3.2.4）
	async addTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const title = asOptionalString(args.title);
		if (!title) return fail("タイトルを指定してください。");

		// ルーチン（繰り返し）指定の検証
		const repeatRule = asOptionalString(args.repeat_rule);
		const dueDate = asOptionalString(args.due_date);
		if (repeatRule) {
			if (!isValidCron(repeatRule)) {
				return fail(
					"repeat_rule は cron式（分 時 日 月 曜日。例 '0 9 * * 1'=毎週月曜）で指定してください。",
				);
			}
			if (!dueDate) {
				return fail(
					"ルーチンタスクには初回の due_date（期日）も指定してください。",
				);
			}
		}
		const repeatUntil = asOptionalString(args.repeat_until);
		const rawCount =
			typeof args.repeat_count === "number" ? args.repeat_count : undefined;
		const repeatCount =
			rawCount !== undefined && Number.isFinite(rawCount) && rawCount > 0
				? Math.floor(rawCount)
				: undefined;

		const todo = todoRepo.addTodo(ctx.userId, ctx.botId, {
			title,
			description: asOptionalString(args.description),
			dueDate,
			startDate: asOptionalString(args.start_date),
			priority: asOptionalPriority(args.priority),
			// ルーチン指定は repeat_rule がある時のみ有効
			repeatRule: repeatRule,
			repeatUntil: repeatRule ? repeatUntil : undefined,
			repeatCount: repeatRule ? repeatCount : undefined,
		});

		// タグ自動付与をバックグラウンドで起動（awaitしない。§3.2.4: 応答をブロックしない）
		scheduleAutoTagging(ctx.userId, ctx.botId, todo.id);

		return ok(
			`ToDo「${todo.title}」を追加しました (ID: #${todo.id}、優先度: ${priorityLabel(todo.priority)}${dueLabel(todo.due_date)}${routineLabel(todo)})。タグはバックグラウンドで自動付与されます。`,
			{ todo: toTodoEntry(todo) },
		);
	},

	// サブタスク追加（§3.2 v12）。親が存在し本人のものであることを確認してから追加する
	async addSubtask(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const title = asOptionalString(args.title);
		const parentId = asTodoId(args.parent_todo_id);
		if (!title) return fail("サブタスクのタイトルを指定してください。");
		const parent = Number.isFinite(parentId)
			? todoRepo.getTodoById(ctx.userId, ctx.botId, parentId)
			: undefined;
		if (!parent)
			return fail(`親タスク #${args.parent_todo_id} が見つかりません。`);

		const subtask = todoRepo.addTodo(ctx.userId, ctx.botId, {
			title,
			description: asOptionalString(args.description),
			dueDate: asOptionalString(args.due_date),
			startDate: asOptionalString(args.start_date),
			parentId: parent.id,
		});
		scheduleAutoTagging(ctx.userId, ctx.botId, subtask.id);

		// 親（祖父に付け替えられている可能性があるので subtask.parent_id 基準）の最新進捗を返す
		const effectiveParentId = subtask.parent_id ?? parent.id;
		const siblings = todoRepo.listSubtasks(
			ctx.userId,
			ctx.botId,
			effectiveParentId,
		);
		const done = siblings.filter((s) => s.status === "done").length;
		return ok(
			`サブタスク「${subtask.title}」(#${subtask.id}) を タスク#${effectiveParentId} に追加しました。${dueLabel(subtask.due_date)}（このタスクのサブタスク: ${done}/${siblings.length} 完了）`,
			{ subtask: toTodoEntry(subtask), parent_todo_id: effectiveParentId },
		);
	},

	// ToDo一覧（§3.2.1: 一覧・タグ別・グループ別表示）
	async listTodos(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const statusArg = asOptionalString(args.status);
		const status: "open" | "done" | "all" =
			statusArg === "done" || statusArg === "all" ? statusArg : "open";
		const tag = asOptionalString(args.tag);

		const todos = todoRepo.listTodoTree(ctx.userId, ctx.botId, { status, tag });
		if (todos.length === 0) {
			return ok(
				tag
					? `タグ「${tag}」のToDoはありません。listTodoTags で存在するタグを確認できます。`
					: "該当するToDoはありません。",
				{ todos: [] },
			);
		}

		const lines = todos.map(todoTreeLines);
		return ok(
			`ToDo一覧 (親タスク ${todos.length}件${tag ? `、タグ: ${tag}` : ""}):\n${lines.join("\n")}`,
			{ todos: todos.map(toTodoTreeEntry) },
		);
	},

	// ToDo完了（§3.2.1）
	async completeTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);
		const todo = todoRepo.completeTodo(ctx.userId, ctx.botId, todoId);
		if (!todo) return fail(`ToDo #${args.todo_id} が見つかりません。`);
		return ok(`ToDo「${todo.title}」(#${todo.id}) を完了にしました✅`, {
			todo: toTodoEntry(todo),
		});
	},

	// ToDo削除（§3.2.1）
	async deleteTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);
		const deleted = todoRepo.deleteTodo(ctx.userId, ctx.botId, todoId);
		if (!deleted) return fail(`ToDo #${args.todo_id} が見つかりません。`);
		return ok(`ToDo #${args.todo_id} を削除しました🗑️`);
	},

	// ToDo更新（§3.2.1）。内容変更時はタグを自動で付け直す（§3.2.4: 更新のたびに付与）
	async updateTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);

		const statusArg = asOptionalString(args.status);
		const status =
			statusArg === "open" || statusArg === "done" ? statusArg : undefined;
		const priorityArg = asOptionalString(args.priority);
		if (priorityArg && !asOptionalPriority(priorityArg)) {
			return fail(
				"優先度は 'high' | 'medium' | 'low' のいずれかで指定してください。",
			);
		}

		const title = asOptionalString(args.title);
		const description = asOptionalString(args.description);
		// due_date / start_date は空文字（クリア指示）も有効値として扱う
		const dueDate =
			typeof args.due_date === "string" ? args.due_date.trim() : undefined;
		const startDate =
			typeof args.start_date === "string" ? args.start_date.trim() : undefined;

		if (
			title === undefined &&
			description === undefined &&
			dueDate === undefined &&
			startDate === undefined &&
			priorityArg === undefined &&
			status === undefined
		) {
			return fail("変更する項目を1つ以上指定してください。");
		}

		const todo = todoRepo.updateTodo(ctx.userId, ctx.botId, todoId, {
			title,
			description,
			dueDate,
			startDate,
			priority: asOptionalPriority(priorityArg),
			status,
		});
		if (!todo) return fail(`ToDo #${args.todo_id} が見つかりません。`);

		// タイトル・説明が変わった場合はタグを付け直す（バックグラウンド・awaitしない）
		if (title !== undefined || description !== undefined) {
			scheduleAutoTagging(ctx.userId, ctx.botId, todo.id);
		}

		return ok(`ToDo「${todo.title}」(#${todo.id}) を更新しました📝`, {
			todo: toTodoEntry(todo),
		});
	},

	// 進捗更新（§3.2 v12）。サブタスクを持つ親は子から算出されるため弾く
	async updateTaskProgress(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);
		const rawProgress = typeof args.progress === "number" ? args.progress : NaN;
		if (!Number.isFinite(todoId) || !Number.isFinite(rawProgress)) {
			return fail("todo_id と progress（0〜100の数値）を指定してください。");
		}

		const todo = todoRepo.getTodoById(ctx.userId, ctx.botId, todoId);
		if (!todo) return fail(`タスク #${args.todo_id} が見つかりません。`);
		// 親タスク（サブタスクあり）は進捗が自動算出されるため手動更新を拒否する
		const subtasks = todoRepo.listSubtasks(ctx.userId, ctx.botId, todoId);
		if (subtasks.length > 0) {
			const done = subtasks.filter((s) => s.status === "done").length;
			return fail(
				`タスク#${todoId}「${todo.title}」はサブタスクを ${subtasks.length} 件持つため、進捗は『完了サブタスク数/全体』(現在 ${done}/${subtasks.length}) で自動算出されます。該当サブタスクを完了/進捗更新してください。`,
			);
		}

		const note = asOptionalString(args.note);
		const updated = todoRepo.updateProgress(
			ctx.userId,
			ctx.botId,
			todoId,
			rawProgress,
			note,
		);
		if (!updated)
			return fail(`タスク #${args.todo_id} の進捗更新に失敗しました。`);
		const doneSuffix = updated.status === "done" ? "（完了にしました✅）" : "";
		return ok(
			`タスク「${updated.title}」(#${updated.id}) の進捗を ${updated.progress}% に更新しました📊${note ? `（メモ: ${note}）` : ""}${doneSuffix}`,
			{ todo: toTodoEntry(updated) },
		);
	},

	// タスク詳細（サブタスク・算出進捗・進捗履歴）（§3.2 v12）
	async getTaskDetail(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);
		const todo = Number.isFinite(todoId)
			? todoRepo.getTodoById(ctx.userId, ctx.botId, todoId)
			: undefined;
		if (!todo) return fail(`タスク #${args.todo_id} が見つかりません。`);
		const subtasks = todoRepo.listSubtasks(ctx.userId, ctx.botId, todoId);
		const logs = todoRepo.listProgressLogs(ctx.userId, ctx.botId, todoId);
		const effectiveProgress = todoRepo.computeEffectiveProgress(todo, subtasks);

		return ok(
			`タスク「${todo.title}」(#${todo.id}) の詳細です。進捗 ${effectiveProgress}%、サブタスク ${subtasks.filter((s) => s.status === "done").length}/${subtasks.length} 完了、進捗履歴 ${logs.length} 件。`,
			{
				todo: toTodoEntry(todo),
				effective_progress: effectiveProgress,
				subtasks: subtasks.map(toTodoEntry),
				progress_logs: logs.map((l) => ({
					progress: l.progress,
					note: l.note,
					created_at: l.created_at,
				})),
			},
		);
	},

	// タグ一覧と件数（§3.2.4: グループ表示用）
	async listTodoTags(ctx: ToolContext): Promise<string> {
		const tags = todoRepo.listAllTags(ctx.userId, ctx.botId);
		if (tags.length === 0) {
			return ok("タグの付いた未完了ToDoはありません。", { tags: [] });
		}
		const lines = tags.map((t) => `🏷️ ${t.tag} (${t.count}件)`);
		return ok(
			`タグ一覧 (${tags.length}種類):\n${lines.join("\n")}\n特定タグのToDoは listTodos の tag 引数で絞り込めます。`,
			{ tags },
		);
	},

	// タグ手動修正（§3.2.4）。set/add/remove で現在のタグを編集し上書き保存する
	async editTodoTags(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);
		if (!Number.isFinite(todoId))
			return fail("todo_id（#番号）を指定してください。");
		const modeArg = asOptionalString(args.mode) ?? "set";
		if (modeArg !== "set" && modeArg !== "add" && modeArg !== "remove") {
			return fail(
				"mode は 'set' | 'add' | 'remove' のいずれかで指定してください。",
			);
		}
		const inputTags = normalizeTags(args.tags);
		if (modeArg !== "set" && inputTags.length === 0) {
			return fail(`${modeArg} には tags を1つ以上指定してください。`);
		}

		const todo = todoRepo.getTodoById(ctx.userId, ctx.botId, todoId);
		if (!todo) return fail(`タスク #${args.todo_id} が見つかりません。`);

		const current = parseTodoTags(todo);
		let next: string[];
		if (modeArg === "set") {
			next = inputTags;
		} else if (modeArg === "add") {
			next = normalizeTags([...current, ...inputTags]);
		} else {
			const remove = new Set(inputTags);
			next = current.filter((t) => !remove.has(t));
		}

		const updated = todoRepo.updateTodoTags(
			ctx.userId,
			ctx.botId,
			todoId,
			next,
		);
		if (!updated)
			return fail(`タスク #${args.todo_id} のタグ更新に失敗しました。`);
		const tagLabel = next.length > 0 ? next.join(", ") : "（タグなし）";
		return ok(
			`タスク「${todo.title}」(#${todo.id}) のタグを更新しました🏷️ → ${tagLabel}`,
			{ todo_id: todo.id, tags: next },
		);
	},

	// タグ別グルーピング（§3.2.4: グループ表示）。複数タグ持ちは各グループに重複して入る
	async listTasksByTag(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const statusArg = asOptionalString(args.status);
		const status: "open" | "done" | "all" =
			statusArg === "done" || statusArg === "all" ? statusArg : "open";

		const todos = todoRepo.listTodoTree(ctx.userId, ctx.botId, { status });
		if (todos.length === 0) {
			return ok("該当するToDoはありません。", { groups: [] });
		}

		// タグ → タスク群へ振り分け（タグ無しは「未分類」へ）
		const UNTAGGED = "未分類";
		const buckets = new Map<string, TodoWithSubtasks[]>();
		for (const todo of todos) {
			const tags = parseTodoTags(todo);
			const keys = tags.length > 0 ? tags : [UNTAGGED];
			for (const key of keys) {
				const bucket = buckets.get(key);
				if (bucket) bucket.push(todo);
				else buckets.set(key, [todo]);
			}
		}

		// 件数の多い順（未分類は常に最後）にグループを並べる
		const groups = [...buckets.entries()]
			.sort((a, b) => {
				if (a[0] === UNTAGGED) return 1;
				if (b[0] === UNTAGGED) return -1;
				return b[1].length - a[1].length || a[0].localeCompare(b[0]);
			})
			.map(([tag, items]) => ({ tag, items }));

		const message = groups
			.map(
				(g) =>
					`🏷️ ${g.tag} (${g.items.length}件)\n${g.items.map(todoTreeLines).join("\n")}`,
			)
			.join("\n\n");

		return ok(`タグ別グループ (${groups.length}グループ):\n${message}`, {
			groups: groups.map((g) => ({
				tag: g.tag,
				count: g.items.length,
				todos: g.items.map(toTodoTreeEntry),
			})),
		});
	},

	// タスクの使い方ガイド（§3.2）。本文MDとページURLを返し、LLMがペルソナ口調で案内する
	async getTaskUsageGuide(): Promise<string> {
		return ok(
			"タスク機能の使い方ガイドです。guide_markdown の内容を、あなた自身の口調・人格に合わせて自然に言い換えてユーザーに伝え、最後に guide_url のリンクも必ず案内してください（要点は省略しないこと）。",
			{ guide_markdown: TASK_USAGE_GUIDE_MD, guide_url: taskGuideUrl() },
		);
	},

	// ルーチン終了（§3.2 v16）。repeat_* をクリアして単発タスクへ戻す（タスク自体は残す）
	async stopTodoRoutine(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = asTodoId(args.todo_id);
		if (!Number.isFinite(todoId))
			return fail("todo_id（#番号）を指定してください。");
		const stopped = todoRepo.stopRoutine(ctx.userId, ctx.botId, todoId);
		if (!stopped) {
			// 対象なし＝存在しない or 既にルーチンでない
			const exists = todoRepo.getTodoById(ctx.userId, ctx.botId, todoId);
			return fail(
				exists
					? `タスク #${args.todo_id} はルーチン（繰り返し）ではありません。`
					: `タスク #${args.todo_id} が見つかりません。`,
			);
		}
		return ok(
			`タスク「${stopped.title}」(#${stopped.id}) の繰り返しを終了しました🏁（このタスクは単発として残ります）`,
			{ todo: toTodoEntry(stopped) },
		);
	},

	// タスク優先度整理・第一段階: 分析用データの取得（§3.2.3: 提案のみ・確定はユーザー承認後）
	async organizeTaskPriorities(ctx: ToolContext): Promise<string> {
		const todos = todoRepo.listTodos(ctx.userId, ctx.botId, { status: "open" });
		if (todos.length === 0) {
			return ok("未完了のToDoがないため、優先度整理の対象はありません。", {
				todos: [],
			});
		}

		return ok(
			`未完了ToDo ${todos.length}件を取得しました。期限の近さ・タイトルや説明から読み取れる重要度・タグを考慮して各ToDoの優先度（high/medium/low）を分析し、提案として理由付きでユーザーに提示してください。` +
				`ユーザーの承認を得てから applyTaskPriorities で確定すること。承認前に勝手に確定してはいけません（§3.2.3）。`,
			{ now: new Date().toISOString(), todos: todos.map(toTodoEntry) },
		);
	},

	// タスク優先度整理・第二段階: ユーザー承認後の一括確定（§3.2.3）
	async applyTaskPriorities(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		if (!Array.isArray(args.items) || args.items.length === 0) {
			return fail(
				"items に {todo_id, priority} の配列を1件以上指定してください。",
			);
		}

		const items: { id: number; priority: TodoPriority }[] = [];
		for (const raw of args.items as unknown[]) {
			const item = raw as Record<string, unknown>;
			const id = asTodoId(item.todo_id);
			const priority = asOptionalPriority(item.priority);
			if (!Number.isFinite(id) || !priority) {
				return fail(
					`不正な項目があります: ${JSON.stringify(item)}（todo_id は数値、priority は 'high'|'medium'|'low'）`,
				);
			}
			items.push({ id, priority });
		}

		// トランザクションで一括更新（未完了ToDoのみ対象）
		const updated = todoRepo.updateTodoPriorities(ctx.userId, ctx.botId, items);
		if (updated === 0) {
			return fail(
				"更新対象が見つかりませんでした。IDが正しいか、ToDoが未完了かを確認してください。",
			);
		}

		const skipped = items.length - updated;
		return ok(
			`${updated}件のToDoの優先度を確定しました🗂️` +
				(skipped > 0
					? `（${skipped}件は見つからない・完了済みのためスキップ）`
					: ""),
			{ updated_count: updated },
		);
	},
};

// ─── Module Export ───────────────────────────────────────────────────────────

/** ToDo・タグ管理・優先度整理 FunctionModule（functions/index.ts でレジストリへマージする） */
export const todoFunctions: FunctionModule = {
	declarations,
	handlers,
};
