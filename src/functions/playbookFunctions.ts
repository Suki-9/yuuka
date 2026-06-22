import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
	savePlaybook,
	findPlaybooks,
	getPlaybookByName,
	deletePlaybook,
} from "../services/playbookService.js";
import { getRecentActions } from "../services/actionRecorder.js";

// ─── 操作記憶（マクロ）Function（§3.6） ──────────────────────────────────────
// 説明ベース登録: savePlaybook（ユーザーが手順を説明 → LLMが構造化して保存）
// 実行ベース登録: getRecentActionHistory → LLMが手順を要約 → ユーザー承認 → savePlaybook
// 呼び出し: findPlaybooks でマッチ → ユーザー確認 → runPlaybook で手順取得 → LLMが実行

const declarations: FunctionDeclaration[] = [
	{
		name: "savePlaybook",
		description:
			"一連の操作手順をマクロ（Playbook）として永続保存します。ユーザーから「この手順を覚えておいて」「『〜〜』という名前で保存して」と指示された際に呼び出します。" +
			"保存前に必ず呼び出し名・説明・手順の内容をユーザーに提示して承認を得てください（§3.6.2）。" +
			"手順を説明された場合（説明ベース登録）はその内容を構造化し、直前にBotが実行した操作を覚える場合（実行ベース登録）は先に getRecentActionHistory で操作履歴を取得してから手順に要約してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description:
						"マクロの英数字ファイル名 (例: 'example_login', 'morning_check')",
				},
				title: {
					type: SchemaType.STRING,
					description:
						"マクロの分かりやすい日本語タイトル（呼び出し名。例: '朝の確認', 'サンプルサイトのログインと請求書取得'）",
				},
				keywords: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description:
						"次回呼び出し時にヒットさせたい関連キーワードのリスト (例: ['朝', '確認', 'ニュース'])",
				},
				description: {
					type: SchemaType.STRING,
					description: "このマクロが何を行うものかの簡単な説明",
				},
				steps: {
					type: SchemaType.STRING,
					description:
						"Markdown形式の具体的な操作手順。使用する具体的なツール名（browserInteractiveOpen, browserFillCredential 等）や判定ロジックを含めると再実行の精度が上がります。",
				},
			},
			required: ["name", "title", "keywords", "description", "steps"],
		},
	},
	{
		name: "findPlaybooks",
		description:
			"登録済みマクロ（Playbook）の一覧、またはキーワード部分一致での検索結果（中身の手順を含む）を取得します。" +
			"ブラウザ自動化や操作自動化を指示された際、対応するマクロが既に登録されていないか確認する目的で最初に呼び出します。" +
			"また、ユーザーがマクロの呼び出し名らしき短いフレーズ（例:「朝の確認」）を送った場合もまず本関数でマッチングし、" +
			"見つかったら実行内容を要約してユーザーに確認し、承認を得てから runPlaybook で実行してください（§3.6.3）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				query: {
					type: SchemaType.STRING,
					description:
						"検索したいキーワードや部分一致の文字列 (例: 'ログイン', 'でんき')。省略した場合は全マクロの一覧を返します。",
				},
			},
		},
	},
	{
		name: "getRecentActionHistory",
		description:
			"このユーザーとの会話で直近に実行したツール操作（Function Call）の履歴を取得します（実行ベースのマクロ登録 §3.6.2）。" +
			"ユーザーが「今の操作を覚えておいて」「これを記憶して」と言ったら本関数で履歴を取得し、" +
			"手順をMarkdownに要約してマクロ候補（呼び出し名・説明・手順）をユーザーに提示し、承認を得てから savePlaybook で保存してください。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "runPlaybook",
		description:
			"指定した名前のマクロ（Playbook）の手順を取得します。ユーザーが実行を承認した後に呼び出し、" +
			"返された手順（steps）に厳密に従って各ツールを順番に実行してください。" +
			"手順内の各ステップが失敗した場合は中断し、どのステップで何が起きたかをユーザーに正直に報告してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description:
						"実行するマクロの英数字名（findPlaybooks の結果の name）",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "deletePlaybook",
		description:
			"マクロ（Playbook）を削除します。削除前に対象のタイトルをユーザーに確認すること。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description: "削除するマクロの英数字名",
				},
			},
			required: ["name"],
		},
	},
];

const handlers: FunctionModule["handlers"] = {
	async savePlaybook(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const name = String(args.name ?? "").trim();
		const title = String(args.title ?? "").trim();
		const description = String(args.description ?? "").trim();
		const steps = String(args.steps ?? "").trim();
		const keywords = Array.isArray(args.keywords)
			? (args.keywords as unknown[]).map(String)
			: [];

		if (!name || !title || !steps) {
			return JSON.stringify({
				success: false,
				message: "name・title・steps は必須です。",
			});
		}

		const result = savePlaybook(
			ctx.userId,
			ctx.botId,
			name,
			title,
			keywords,
			description,
			steps,
		);
		return JSON.stringify(result);
	},

	async findPlaybooks(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const query = args.query ? String(args.query).trim() : undefined;
		const playbooks = findPlaybooks(ctx.userId, ctx.botId, query);
		if (playbooks.length === 0) {
			return JSON.stringify({
				success: true,
				count: 0,
				message: query
					? `「${query}」に合致するマクロは見つかりませんでした。`
					: "登録済みのマクロはありません。",
				playbooks: [],
			});
		}
		return JSON.stringify({
			success: true,
			count: playbooks.length,
			playbooks,
		});
	},

	async getRecentActionHistory(ctx: ToolContext): Promise<string> {
		const actions = await getRecentActions(ctx.userId);
		if (actions.length === 0) {
			return JSON.stringify({
				success: true,
				count: 0,
				message:
					"直近の操作履歴がありません（履歴は2時間で揮発します）。ユーザーに手順を説明してもらい、説明ベースで登録してください。",
				actions: [],
			});
		}
		return JSON.stringify({
			success: true,
			count: actions.length,
			message:
				"直近の操作履歴です。この履歴から再実行可能な手順をMarkdownに要約し、マクロ候補（呼び出し名・説明・手順）をユーザーに提示して、承認を得てから savePlaybook で保存してください。",
			actions,
		});
	},

	async runPlaybook(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const name = String(args.name ?? "").trim();
		if (!name) {
			return JSON.stringify({ success: false, message: "name は必須です。" });
		}
		const playbook = getPlaybookByName(ctx.userId, ctx.botId, name);
		if (!playbook) {
			return JSON.stringify({
				success: false,
				message: `マクロ「${name}」が見つかりません。findPlaybooks で正しい name を確認してください。`,
			});
		}
		return JSON.stringify({
			success: true,
			message:
				"以下の手順に厳密に従って、各ツールを順番に実行してください。失敗した場合は中断して正直に報告すること。",
			playbook,
		});
	},

	async deletePlaybook(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const name = String(args.name ?? "").trim();
		if (!name) {
			return JSON.stringify({ success: false, message: "name は必須です。" });
		}
		const ok = deletePlaybook(ctx.userId, ctx.botId, name);
		return JSON.stringify({
			success: ok,
			message: ok
				? `マクロ「${name}」を削除しました🗑️`
				: `マクロ「${name}」が見つかりませんでした。`,
		});
	},
};

/** マクロ（Playbook）FunctionModule */
export const playbookFunctions: FunctionModule = {
	declarations,
	handlers,
};
