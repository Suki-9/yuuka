import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { getRecentActions } from "../services/actionRecorder.js";
import {
	deletePlaybook,
	findPlaybooks,
	getPlaybookByName,
	savePlaybook,
} from "../services/playbookService.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

// ─── 操作記憶（マクロ）Function（§3.6） ──────────────────────────────────────
// 説明ベース登録: savePlaybook（ユーザーが手順を説明 → LLMが構造化して保存）
// 実行ベース登録: getRecentActionHistory → LLMが手順を要約 → ユーザー承認 → savePlaybook
// 呼び出し: findPlaybooks でマッチ → ユーザー確認 → runPlaybook で手順取得 → LLMが実行

const declarations: FunctionDeclaration[] = [
	{
		name: "savePlaybook",
		description:
			"操作の手順をマクロ（Playbook）として保存し、あとで呼び出せるようにする。\n" +
			"・例:「この手順を覚えておいて」「『〜〜』という名前で保存して」。\n" +
			"・保存する前に、呼び出し名・説明・手順の内容をユーザーに見せて承認を得てから呼ぶ。\n" +
			"・ユーザーが手順を言葉で説明した時は、その内容を整理して保存する。\n" +
			"・直前にBotがやった操作を覚える時は、先に getRecentActionHistory で操作履歴を取得し、それを手順にまとめてから保存する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description:
						"マクロの英数字のファイル名。例: 'example_login', 'morning_check'。",
				},
				title: {
					type: SchemaType.STRING,
					description:
						"マクロの分かりやすい日本語タイトル（呼び出し名）。例: '朝の確認', 'サンプルサイトのログインと請求書取得'。",
				},
				keywords: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description:
						"次に呼び出す時に見つけやすくする関連キーワードのリスト。例: ['朝', '確認', 'ニュース']。",
				},
				description: {
					type: SchemaType.STRING,
					description: "このマクロが何をするものかの簡単な説明。",
				},
				steps: {
					type: SchemaType.STRING,
					description:
						"Markdown形式の具体的な操作手順。使うツール名（browserInteractiveOpen, browserFillCredential など）や判断の条件を書いておくと、後で再実行する時の正確さが上がる。",
				},
			},
			required: ["name", "title", "keywords", "description", "steps"],
		},
	},
	{
		name: "findPlaybooks",
		description:
			"登録済みマクロ（Playbook）を一覧、またはキーワードで検索する（手順の中身も返る）。\n" +
			"・ブラウザ操作や作業の自動化を頼まれた時、使えるマクロが既にないか最初に確認する目的で使う。\n" +
			"・ユーザーが呼び出し名っぽい短い言葉（例:「朝の確認」）を送った時も、まずこれで探す。\n" +
			"・見つかったら実行内容を要約してユーザーに確認し、承認を得てから runPlaybook で実行する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				query: {
					type: SchemaType.STRING,
					description:
						"検索するキーワードや一部の文字列。例: 'ログイン', 'でんき'。省略=全マクロの一覧を返す。",
				},
			},
		},
	},
	{
		name: "getRecentActionHistory",
		description:
			"このユーザーとの会話で直近にやったツール操作の履歴を取得する（操作をマクロ化する準備に使う）。\n" +
			"・例:「今の操作を覚えておいて」「これを記憶して」。\n" +
			"・取得した履歴を手順としてMarkdownにまとめ、マクロ候補（呼び出し名・説明・手順）をユーザーに見せ、承認を得てから savePlaybook で保存する。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "runPlaybook",
		description:
			"指定した名前のマクロ（Playbook）の手順を取り出して実行できるようにする。\n" +
			"・ユーザーが実行を承認した後で呼ぶ。\n" +
			"・返ってきた手順（steps）の通りに、各ツールを順番どおり実行する。\n" +
			"・途中のステップが失敗したら止めて、どのステップで何が起きたかをユーザーに正直に報告する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description:
						"実行するマクロの英数字名。findPlaybooks の結果に入っている name を使う。",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "deletePlaybook",
		description:
			"マクロ（Playbook）を削除する（元に戻せない）。\n" +
			"・削除する前に、消す対象のタイトルをユーザーに確認してから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description: "削除するマクロの英数字名。",
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
