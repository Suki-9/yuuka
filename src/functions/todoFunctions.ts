import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
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

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** Function Call の引数から空でない文字列を取り出す（無ければ undefined） */
function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
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
	const head = `${statusEmoji(todo.status)} #${todo.id} ${todo.title}${dueLabel(todo.due_date)} ${priorityLabel(todo.priority)} ${progressLabel(todo.effective_progress)}${subInfo}${tagLabel}`;
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
						"締め切り。形式: 日付だけなら YYYY-MM-DD、時刻ありなら YYYY-MM-DDTHH:MM:SS。「明日まで」などは今の日時を基準に変換して入れる（任意）",
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
							todo_id: { type: SchemaType.NUMBER, description: "対象タスクのID" },
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
		if (!title) {
			return JSON.stringify({
				success: false,
				message: "タイトルを指定してください。",
			});
		}

		const todo = todoRepo.addTodo(ctx.userId, ctx.botId, {
			title,
			description: asOptionalString(args.description),
			dueDate: asOptionalString(args.due_date),
			startDate: asOptionalString(args.start_date),
			priority: asOptionalPriority(args.priority),
		});

		// タグ自動付与をバックグラウンドで起動（awaitしない。§3.2.4: 応答をブロックしない）
		scheduleAutoTagging(ctx.userId, ctx.botId, todo.id);

		return JSON.stringify({
			success: true,
			message: `ToDo「${todo.title}」を追加しました (ID: #${todo.id}、優先度: ${priorityLabel(todo.priority)}${dueLabel(todo.due_date)})。タグはバックグラウンドで自動付与されます。`,
			todo: toTodoEntry(todo),
		});
	},

	// サブタスク追加（§3.2 v12）。親が存在し本人のものであることを確認してから追加する
	async addSubtask(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const title = asOptionalString(args.title);
		const parentId =
			typeof args.parent_todo_id === "number" ? args.parent_todo_id : NaN;
		if (!title) {
			return JSON.stringify({
				success: false,
				message: "サブタスクのタイトルを指定してください。",
			});
		}
		const parent = Number.isFinite(parentId)
			? todoRepo.getTodoById(ctx.userId, ctx.botId, parentId)
			: undefined;
		if (!parent) {
			return JSON.stringify({
				success: false,
				message: `親タスク #${args.parent_todo_id} が見つかりません。`,
			});
		}

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
		return JSON.stringify({
			success: true,
			message: `サブタスク「${subtask.title}」(#${subtask.id}) を タスク#${effectiveParentId} に追加しました。${dueLabel(subtask.due_date)}（このタスクのサブタスク: ${done}/${siblings.length} 完了）`,
			subtask: toTodoEntry(subtask),
			parent_todo_id: effectiveParentId,
		});
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
			return JSON.stringify({
				success: true,
				message: tag
					? `タグ「${tag}」のToDoはありません。listTodoTags で存在するタグを確認できます。`
					: "該当するToDoはありません。",
				todos: [],
			});
		}

		const lines = todos.map(todoTreeLines);
		return JSON.stringify({
			success: true,
			message: `ToDo一覧 (親タスク ${todos.length}件${tag ? `、タグ: ${tag}` : ""}):\n${lines.join("\n")}`,
			todos: todos.map(toTodoTreeEntry),
		});
	},

	// ToDo完了（§3.2.1）
	async completeTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = typeof args.todo_id === "number" ? args.todo_id : NaN;
		const todo = todoRepo.completeTodo(ctx.userId, ctx.botId, todoId);
		if (!todo) {
			return JSON.stringify({
				success: false,
				message: `ToDo #${args.todo_id} が見つかりません。`,
			});
		}
		return JSON.stringify({
			success: true,
			message: `ToDo「${todo.title}」(#${todo.id}) を完了にしました✅`,
			todo: toTodoEntry(todo),
		});
	},

	// ToDo削除（§3.2.1）
	async deleteTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = typeof args.todo_id === "number" ? args.todo_id : NaN;
		const deleted = todoRepo.deleteTodo(ctx.userId, ctx.botId, todoId);
		if (!deleted) {
			return JSON.stringify({
				success: false,
				message: `ToDo #${args.todo_id} が見つかりません。`,
			});
		}
		return JSON.stringify({
			success: true,
			message: `ToDo #${args.todo_id} を削除しました🗑️`,
		});
	},

	// ToDo更新（§3.2.1）。内容変更時はタグを自動で付け直す（§3.2.4: 更新のたびに付与）
	async updateTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = typeof args.todo_id === "number" ? args.todo_id : NaN;

		const statusArg = asOptionalString(args.status);
		const status =
			statusArg === "open" || statusArg === "done" ? statusArg : undefined;
		const priorityArg = asOptionalString(args.priority);
		if (priorityArg && !asOptionalPriority(priorityArg)) {
			return JSON.stringify({
				success: false,
				message:
					"優先度は 'high' | 'medium' | 'low' のいずれかで指定してください。",
			});
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
			return JSON.stringify({
				success: false,
				message: "変更する項目を1つ以上指定してください。",
			});
		}

		const todo = todoRepo.updateTodo(ctx.userId, ctx.botId, todoId, {
			title,
			description,
			dueDate,
			startDate,
			priority: asOptionalPriority(priorityArg),
			status,
		});
		if (!todo) {
			return JSON.stringify({
				success: false,
				message: `ToDo #${args.todo_id} が見つかりません。`,
			});
		}

		// タイトル・説明が変わった場合はタグを付け直す（バックグラウンド・awaitしない）
		if (title !== undefined || description !== undefined) {
			scheduleAutoTagging(ctx.userId, ctx.botId, todo.id);
		}

		return JSON.stringify({
			success: true,
			message: `ToDo「${todo.title}」(#${todo.id}) を更新しました📝`,
			todo: toTodoEntry(todo),
		});
	},

	// 進捗更新（§3.2 v12）。サブタスクを持つ親は子から算出されるため弾く
	async updateTaskProgress(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = typeof args.todo_id === "number" ? args.todo_id : NaN;
		const rawProgress =
			typeof args.progress === "number" ? args.progress : NaN;
		if (!Number.isFinite(todoId) || !Number.isFinite(rawProgress)) {
			return JSON.stringify({
				success: false,
				message: "todo_id と progress（0〜100の数値）を指定してください。",
			});
		}

		const todo = todoRepo.getTodoById(ctx.userId, ctx.botId, todoId);
		if (!todo) {
			return JSON.stringify({
				success: false,
				message: `タスク #${args.todo_id} が見つかりません。`,
			});
		}
		// 親タスク（サブタスクあり）は進捗が自動算出されるため手動更新を拒否する
		const subtasks = todoRepo.listSubtasks(ctx.userId, ctx.botId, todoId);
		if (subtasks.length > 0) {
			const done = subtasks.filter((s) => s.status === "done").length;
			return JSON.stringify({
				success: false,
				message: `タスク#${todoId}「${todo.title}」はサブタスクを ${subtasks.length} 件持つため、進捗は『完了サブタスク数/全体』(現在 ${done}/${subtasks.length}) で自動算出されます。該当サブタスクを完了/進捗更新してください。`,
			});
		}

		const note = asOptionalString(args.note);
		const updated = todoRepo.updateProgress(
			ctx.userId,
			ctx.botId,
			todoId,
			rawProgress,
			note,
		);
		if (!updated) {
			return JSON.stringify({
				success: false,
				message: `タスク #${args.todo_id} の進捗更新に失敗しました。`,
			});
		}
		const doneSuffix = updated.status === "done" ? "（完了にしました✅）" : "";
		return JSON.stringify({
			success: true,
			message: `タスク「${updated.title}」(#${updated.id}) の進捗を ${updated.progress}% に更新しました📊${note ? `（メモ: ${note}）` : ""}${doneSuffix}`,
			todo: toTodoEntry(updated),
		});
	},

	// タスク詳細（サブタスク・算出進捗・進捗履歴）（§3.2 v12）
	async getTaskDetail(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const todoId = typeof args.todo_id === "number" ? args.todo_id : NaN;
		const todo = Number.isFinite(todoId)
			? todoRepo.getTodoById(ctx.userId, ctx.botId, todoId)
			: undefined;
		if (!todo) {
			return JSON.stringify({
				success: false,
				message: `タスク #${args.todo_id} が見つかりません。`,
			});
		}
		const subtasks = todoRepo.listSubtasks(ctx.userId, ctx.botId, todoId);
		const logs = todoRepo.listProgressLogs(ctx.userId, ctx.botId, todoId);
		const effectiveProgress = todoRepo.computeEffectiveProgress(todo, subtasks);

		return JSON.stringify({
			success: true,
			message: `タスク「${todo.title}」(#${todo.id}) の詳細です。進捗 ${effectiveProgress}%、サブタスク ${subtasks.filter((s) => s.status === "done").length}/${subtasks.length} 完了、進捗履歴 ${logs.length} 件。`,
			todo: toTodoEntry(todo),
			effective_progress: effectiveProgress,
			subtasks: subtasks.map(toTodoEntry),
			progress_logs: logs.map((l) => ({
				progress: l.progress,
				note: l.note,
				created_at: l.created_at,
			})),
		});
	},

	// タグ一覧と件数（§3.2.4: グループ表示用）
	async listTodoTags(ctx: ToolContext): Promise<string> {
		const tags = todoRepo.listAllTags(ctx.userId, ctx.botId);
		if (tags.length === 0) {
			return JSON.stringify({
				success: true,
				message: "タグの付いた未完了ToDoはありません。",
				tags: [],
			});
		}
		const lines = tags.map((t) => `🏷️ ${t.tag} (${t.count}件)`);
		return JSON.stringify({
			success: true,
			message: `タグ一覧 (${tags.length}種類):\n${lines.join("\n")}\n特定タグのToDoは listTodos の tag 引数で絞り込めます。`,
			tags,
		});
	},

	// タスク優先度整理・第一段階: 分析用データの取得（§3.2.3: 提案のみ・確定はユーザー承認後）
	async organizeTaskPriorities(ctx: ToolContext): Promise<string> {
		const todos = todoRepo.listTodos(ctx.userId, ctx.botId, { status: "open" });
		if (todos.length === 0) {
			return JSON.stringify({
				success: true,
				message: "未完了のToDoがないため、優先度整理の対象はありません。",
				todos: [],
			});
		}

		return JSON.stringify({
			success: true,
			message:
				`未完了ToDo ${todos.length}件を取得しました。期限の近さ・タイトルや説明から読み取れる重要度・タグを考慮して各ToDoの優先度（high/medium/low）を分析し、提案として理由付きでユーザーに提示してください。` +
				`ユーザーの承認を得てから applyTaskPriorities で確定すること。承認前に勝手に確定してはいけません（§3.2.3）。`,
			now: new Date().toISOString(),
			todos: todos.map(toTodoEntry),
		});
	},

	// タスク優先度整理・第二段階: ユーザー承認後の一括確定（§3.2.3）
	async applyTaskPriorities(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		if (!Array.isArray(args.items) || args.items.length === 0) {
			return JSON.stringify({
				success: false,
				message:
					"items に {todo_id, priority} の配列を1件以上指定してください。",
			});
		}

		const items: { id: number; priority: TodoPriority }[] = [];
		for (const raw of args.items as unknown[]) {
			const item = raw as Record<string, unknown>;
			const id = typeof item.todo_id === "number" ? item.todo_id : NaN;
			const priority = asOptionalPriority(item.priority);
			if (!Number.isFinite(id) || !priority) {
				return JSON.stringify({
					success: false,
					message: `不正な項目があります: ${JSON.stringify(item)}（todo_id は数値、priority は 'high'|'medium'|'low'）`,
				});
			}
			items.push({ id, priority });
		}

		// トランザクションで一括更新（未完了ToDoのみ対象）
		const updated = todoRepo.updateTodoPriorities(ctx.userId, ctx.botId, items);
		if (updated === 0) {
			return JSON.stringify({
				success: false,
				message:
					"更新対象が見つかりませんでした。IDが正しいか、ToDoが未完了かを確認してください。",
			});
		}

		const skipped = items.length - updated;
		return JSON.stringify({
			success: true,
			message:
				`${updated}件のToDoの優先度を確定しました🗂️` +
				(skipped > 0
					? `（${skipped}件は見つからない・完了済みのためスキップ）`
					: ""),
			updated_count: updated,
		});
	},
};

// ─── Module Export ───────────────────────────────────────────────────────────

/** ToDo・タグ管理・優先度整理 FunctionModule（functions/index.ts でレジストリへマージする） */
export const todoFunctions: FunctionModule = {
	declarations,
	handlers,
};
