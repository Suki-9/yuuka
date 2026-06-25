import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import {
	deleteAllGrantsForCredential,
	grantCredentialToBot,
	isCredentialGrantedToBot,
	listCredentialNamesForBot,
} from "../db/credentialAccessRepo.js";
import { browserInteractiveType } from "../services/browserService.js";
import * as secretService from "../services/secretService.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

// ─── パスワードマネージャ Function 群（§6.4） ────────────────────────────────
//
// LLMによるパスワードマネージャ操作は本モジュールの5関数のみに制限する（§6.4）。
// 旧 getCredential（平文パスワードをLLMへ返却）は廃止。代替の browserFillCredential は
// 復号した認証情報を browserService.browserInteractiveType へ直接渡してブラウザに入力し、
// LLMの応答・ログ・プロンプトに平文パスワードが一切含まれない構成とする（§6.3.2）。
// 監査ログ（credential.read/write/delete）は secretService 層が記録する（§6.3.3）。

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** Function Call の引数から空でない文字列を取り出す（無ければ undefined） */
function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** パスワード引数の取り出し（前後空白も意味を持ち得るため trim しない） */
function asOptionalPassword(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	return value;
}

/**
 * エラーメッセージから秘密値を除去する（多重防御）。
 * browserService 等のエラー文に万一ユーザー名・パスワードが混入しても LLM に渡さない。
 */
function sanitizeErrorMessage(message: string, secrets: string[]): string {
	let sanitized = message;
	for (const secret of secrets) {
		if (secret && sanitized.includes(secret)) {
			sanitized = sanitized.split(secret).join("***");
		}
	}
	return sanitized;
}

// ─── Function Declarations ───────────────────────────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "listCredentialServices",
		description:
			"パスワード保管庫に登録済みのサービス名・ユーザー名・URLの一覧を見る（パスワードは出ない）。\n" +
				"・例:「どのサービスのアカウントを登録してる？」と聞かれた時。\n" +
				"・ブラウザ自動ログイン（browserFillCredential）の前に、正しいサービス名を確かめたい時にも使う。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "addCredential",
		description:
			"新しいログイン情報（サービス名・ユーザー名・パスワード・URL）をパスワード保管庫に登録する。\n" +
				"・ユーザーが「登録して」とはっきり頼んだ時だけ呼ぶ。\n" +
				"・呼ぶ前に、登録する内容（サービス名・ユーザー名・URL。パスワードは「受け取ったパスワード」とだけ言う）をユーザーに読み上げて確認をもらう。\n" +
				"・確認なしに勝手に登録しない。\n" +
				"・パスワードの中身は返信に書かない（登録後の返事にも入れない）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"サービス名（例: 'github', '社内ポータル'）。小文字にそろえて保存される。",
				},
				username: {
					type: SchemaType.STRING,
					description: "ログインに使うユーザー名またはメールアドレス。",
				},
				password: {
					type: SchemaType.STRING,
					description:
						"パスワード。暗号化して保存される。この値を以後の返信に書かないこと。",
				},
				url: {
					type: SchemaType.STRING,
					description:
						"ログインページのURL（任意）。ブラウザ自動ログインで開くページの目安になる。",
				},
			},
			required: ["service_name", "username", "password"],
		},
	},
	{
		name: "updateCredential",
		description:
			"登録済みのログイン情報を変更する（ユーザー名・パスワード・URLのうち指定した項目だけ書き換え）。\n" +
				"・ユーザーが「変えて」とはっきり頼んだ時だけ呼ぶ。\n" +
				"・呼ぶ前に「どのサービスの・どの項目を変えるか」をユーザーに読み上げて確認をもらう。\n" +
				"・新旧どちらのパスワードの中身も返信に書かない。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"変更したいサービス名。listCredentialServices で確認できる。",
				},
				username: {
					type: SchemaType.STRING,
					description: "新しいユーザー名。変える時だけ指定する。",
				},
				password: {
					type: SchemaType.STRING,
					description:
						"新しいパスワード。変える時だけ指定する。この値を以後の返信に書かないこと。",
				},
				url: {
					type: SchemaType.STRING,
					description:
						"新しいログインページのURL。変える時だけ指定する。空文字を入れるとURLを消す。",
				},
			},
			required: ["service_name"],
		},
	},
	{
		name: "deleteCredential",
		description:
			"登録済みのログイン情報を保管庫から完全に消す（取り消せない）。\n" +
				"・ユーザーが「消して」とはっきり頼んだ時だけ呼ぶ。\n" +
				"・呼ぶ前に、消すサービス名をユーザーに読み上げて確認をもらう。\n" +
				"・確認なしに勝手に消さない。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"消したいサービス名。listCredentialServices で確認できる。",
				},
			},
			required: ["service_name"],
		},
	},
	{
		name: "browserFillCredential",
		description:
			"保管庫のログイン情報を、いま開いているブラウザのページの入力欄へ直接打ち込む。\n" +
				"・ユーザー名とパスワードはブラウザにだけ渡り、あなた（LLM）には返らない。\n" +
				"・ユーザーが「ログインして」などはっきり頼んだ時だけ使う。\n" +
				"・自動ログインの手順: (1)browserInteractiveOpen でログインページを開く (2)browserInteractiveStatus で入力欄の数値IDを調べる (3)この関数で username_selector / password_selector に数値IDを渡して入力 (4)browserInteractiveClick でログインボタンを押す。\n" +
				"・セレクタには browserInteractiveStatus に出る数値ID（data-yuuka-id）かCSSセレクタを使う。\n" +
				"・ユーザー名だけ入れたい時は username_selector だけ指定する。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"入力するログイン情報のサービス名。listCredentialServices で確認できる。",
				},
				username_selector: {
					type: SchemaType.STRING,
					description:
						"ユーザー名の入力欄を指すセレクタ（browserInteractiveStatus で調べた数値ID か CSSセレクタ）。省略するとユーザー名は入れない。",
				},
				password_selector: {
					type: SchemaType.STRING,
					description:
						"パスワードの入力欄を指すセレクタ（browserInteractiveStatus で調べた数値ID か CSSセレクタ）。省略するとパスワードは入れない。",
				},
			},
			required: ["service_name"],
		},
	},
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const handlers: FunctionModule["handlers"] = {
	// 登録済みサービス一覧（§6.4 list_services。パスワードは含まない）
	async listCredentialServices(ctx: ToolContext): Promise<string> {
		// v5: 当該Botへ利用を許可済み（bot_credential_access）の認証情報のみを返す。
		// browserFillCredential の isCredentialGrantedToBot ゲート、および HTTP /api/credentials と
		// 一致させ、未許可Botに他の認証情報（サービス名・ユーザー名・URL）を露出させない。
		// 一覧だけ全件見えて利用時にゲートで弾かれる「認識の不整合」を防ぐ。
		const grantedSet = new Set(
			listCredentialNamesForBot(ctx.botId, ctx.userId),
		);
		const services = secretService
			.listCredentialServices(ctx.userId)
			.filter((s) => grantedSet.has(s.service_name));
		if (services.length === 0) {
			return JSON.stringify({
				success: true,
				message:
					"このBotが利用を許可された認証情報はありません。addCredential で登録すると自動的にこのBotへ許可されます。既存の認証情報は統合管理ページ（Bot統合管理）でこのBotへ利用を許可してください。",
				services: [],
			});
		}
		const lines = services.map(
			(s) =>
				`🔑 ${s.service_name}（ユーザー名: ${s.username}${s.url ? `、URL: ${s.url}` : ""}）`,
		);
		return JSON.stringify({
			success: true,
			message: `登録済みサービス一覧 (${services.length}件):\n${lines.join("\n")}\n※パスワードは表示できません。`,
			services,
		});
	},

	// 認証情報の登録（§6.4 add_credential。ユーザー確認フロー必須）
	async addCredential(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const serviceName = asOptionalString(args.service_name);
		const username = asOptionalString(args.username);
		const password = asOptionalPassword(args.password);
		if (!serviceName || !username || !password) {
			return JSON.stringify({
				success: false,
				message: "service_name・username・password は必須です。",
			});
		}

		try {
			secretService.registerCredential(
				ctx.userId,
				serviceName,
				username,
				password,
				asOptionalString(args.url),
			);
			// v5: 会話から登録した場合は、いま応対している（秘書）Bot自身へ即時に利用許可する（UX維持）。
			// 他Botへの共有は統合管理ページで行う。
			grantCredentialToBot(
				ctx.botId,
				ctx.userId,
				serviceName.trim().toLowerCase(),
			);
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: sanitizeErrorMessage((err as Error).message, [password]),
			});
		}

		return JSON.stringify({
			success: true,
			message: `「${serviceName.trim().toLowerCase()}」の認証情報を暗号化して登録しました🔐（ユーザー名: ${username}）。返信にパスワードの値を含めず、ユーザーにはチャット上のパスワード送信メッセージの削除を勧めてください。`,
		});
	},

	// 認証情報の更新（§6.4 update_credential。ユーザー確認フロー必須・新旧PWは応答に含めない）
	async updateCredential(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const serviceName = asOptionalString(args.service_name);
		if (!serviceName) {
			return JSON.stringify({
				success: false,
				message: "service_name を指定してください。",
			});
		}

		const username = asOptionalString(args.username);
		const password = asOptionalPassword(args.password);
		// url は空文字＝削除の意図を許容するため、文字列であればそのまま受け取る
		const url = typeof args.url === "string" ? args.url : undefined;

		if (username === undefined && password === undefined && url === undefined) {
			return JSON.stringify({
				success: false,
				message:
					"更新する項目（username / password / url）を1つ以上指定してください。",
			});
		}

		try {
			const updated = secretService.updateCredential(ctx.userId, serviceName, {
				username,
				password,
				url,
			});
			if (!updated) {
				return JSON.stringify({
					success: false,
					message: `サービス「${serviceName}」の認証情報が見つかりません。listCredentialServices で登録済みサービス名を確認してください。`,
				});
			}
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: sanitizeErrorMessage(
					(err as Error).message,
					password ? [password] : [],
				),
			});
		}

		const changed = [
			username !== undefined ? "ユーザー名" : null,
			password !== undefined ? "パスワード" : null,
			url !== undefined ? "URL" : null,
		].filter((v): v is string => v !== null);
		return JSON.stringify({
			success: true,
			message: `「${serviceName.trim().toLowerCase()}」の${changed.join("・")}を更新しました🔐。返信にパスワードの値を含めないでください。`,
		});
	},

	// 認証情報の削除（§6.4 delete_credential。ユーザー確認フロー必須）
	async deleteCredential(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const serviceName = asOptionalString(args.service_name);
		if (!serviceName) {
			return JSON.stringify({
				success: false,
				message: "service_name を指定してください。",
			});
		}

		const deleted = secretService.deleteCredential(ctx.userId, serviceName);
		if (!deleted) {
			return JSON.stringify({
				success: false,
				message: `サービス「${serviceName}」の認証情報が見つかりません。listCredentialServices で登録済みサービス名を確認してください。`,
			});
		}
		// v5: 削除に伴い全Botの利用許可も掃除する（credentials への DB FK が無いため明示的に）。
		deleteAllGrantsForCredential(ctx.userId, serviceName.trim().toLowerCase());
		return JSON.stringify({
			success: true,
			message: `「${serviceName.trim().toLowerCase()}」の認証情報を削除しました🗑️`,
		});
	},

	// 復号した認証情報をブラウザへ直接入力（§6.4 get_credential 相当。値はLLMに返さない）
	async browserFillCredential(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const serviceName = asOptionalString(args.service_name);
		if (!serviceName) {
			return JSON.stringify({
				success: false,
				message: "service_name を指定してください。",
			});
		}

		const usernameSelector = asOptionalString(args.username_selector);
		const passwordSelector = asOptionalString(args.password_selector);
		if (!usernameSelector && !passwordSelector) {
			return JSON.stringify({
				success: false,
				message:
					"入力先フィールドが指定されていません。先に browserInteractiveStatus を呼び出してページ内のユーザー名・パスワード入力欄の数値ID（data-yuuka-id）を確認し、username_selector / password_selector に指定して再度呼び出してください。",
			});
		}

		// v5: 当該Botがこの認証情報の利用を許可されているか検証する（許可リスト）。
		// 認証情報・ブラウザ操作は秘書専用capabilityのため、発話者 ctx.userId が認証情報のowner。
		const cleanServiceName = serviceName.trim().toLowerCase();
		if (!isCredentialGrantedToBot(ctx.botId, ctx.userId, cleanServiceName)) {
			return JSON.stringify({
				success: false,
				message: `このBotは認証情報「${cleanServiceName}」の利用を許可されていません。統合管理ページ（Bot統合管理）で当該Botへ利用を許可してください。`,
			});
		}

		// 復号（監査ログ credential.read は secretService 層で記録される）
		let credential: secretService.DecryptedCredential | null;
		try {
			credential = secretService.getDecryptedCredential(
				ctx.userId,
				serviceName,
			);
		} catch (err) {
			return JSON.stringify({
				success: false,
				message: (err as Error).message,
			});
		}
		if (!credential) {
			return JSON.stringify({
				success: false,
				message: `サービス「${serviceName}」の認証情報が見つかりません。listCredentialServices で登録済みサービス名を確認してください。`,
			});
		}

		console.log(
			`🔐 [PWマネージャ] ブラウザへ認証情報を入力します: ${cleanServiceName} (User: ${ctx.userId})`,
		);

		// 復号値は browserService へ直接渡す（LLMの応答・ログに含めない。§6.3.2）
		const filled: string[] = [];
		const secrets = [credential.password, credential.username];
		try {
			if (usernameSelector) {
				await browserInteractiveType(
					ctx.userId,
					usernameSelector,
					credential.username,
				);
				filled.push("ユーザー名");
			}
			if (passwordSelector) {
				await browserInteractiveType(
					ctx.userId,
					passwordSelector,
					credential.password,
				);
				filled.push("パスワード");
			}
		} catch (err) {
			const detail = sanitizeErrorMessage((err as Error).message, secrets);
			return JSON.stringify({
				success: false,
				message:
					(filled.length > 0
						? `${filled.join("と")}の入力後にエラーが発生しました: `
						: "入力に失敗しました: ") +
					`${detail} browserInteractiveStatus で入力欄の数値IDを確認し直してください。`,
			});
		}

		// 戻り値は success / message のみ。username・password の値は一切含めない（§6.3.2）
		return JSON.stringify({
			success: true,
			message: `「${cleanServiceName}」の${filled.join("と")}を入力しました。続けて browserInteractiveClick でログインボタンを押下してください。`,
		});
	},
};

// ─── Module Export ───────────────────────────────────────────────────────────

/** パスワードマネージャ FunctionModule（functions/index.ts でレジストリへマージする） */
export const credentialFunctions: FunctionModule = {
	declarations,
	handlers,
};
