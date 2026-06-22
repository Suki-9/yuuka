import { SchemaType } from "@google/generative-ai";
import type { FunctionDeclaration } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import * as secretService from "../services/secretService.js";
import { browserInteractiveType } from "../services/browserService.js";
import {
	isCredentialGrantedToBot,
	grantCredentialToBot,
	deleteAllGrantsForCredential,
} from "../db/credentialAccessRepo.js";

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
			"パスワードマネージャに登録済みのサービス名・ユーザー名・URLの一覧を取得します（パスワードは一切含まれません）。「どのサービスのアカウントを登録してる？」といった確認や、ブラウザ自動ログイン（browserFillCredential）の前に正しいサービス名を確認する用途で呼び出してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "addCredential",
		description:
			"パスワードマネージャに新しい認証情報（サービス名・ユーザー名・パスワード・URL）を登録します。【重要】ユーザーが明示的に登録を指示した場合のみ呼び出すこと。呼び出す前に必ず登録内容（サービス名・ユーザー名・URL。パスワードは「受け取ったパスワード」とだけ表現）をユーザーに復唱して確認を得ること。確認なしに勝手に登録してはいけません。また、パスワードの値をチャット返信に繰り返してはいけません（登録後の応答にも含めない）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"サービス名（例: 'github', '社内ポータル'）。小文字に正規化して保存されます",
				},
				username: {
					type: SchemaType.STRING,
					description: "ログインに使用するユーザー名またはメールアドレス",
				},
				password: {
					type: SchemaType.STRING,
					description:
						"パスワード（暗号化して保存されます。この値を以後の返信に繰り返さないこと）",
				},
				url: {
					type: SchemaType.STRING,
					description:
						"ログインページのURL（任意。ブラウザ自動ログイン時に開くページの参考になります）",
				},
			},
			required: ["service_name", "username", "password"],
		},
	},
	{
		name: "updateCredential",
		description:
			"パスワードマネージャの既存認証情報を更新します（ユーザー名・パスワード・URLのうち指定した項目のみ変更）。【重要】ユーザーが明示的に更新を指示した場合のみ呼び出すこと。呼び出す前に必ず「どのサービスの・どの項目を変更するか」をユーザーに復唱して確認を得ること。新旧どちらのパスワードの値もチャット返信に繰り返してはいけません。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"更新対象のサービス名（listCredentialServices で確認可能）",
				},
				username: {
					type: SchemaType.STRING,
					description: "新しいユーザー名（変更する場合のみ指定）",
				},
				password: {
					type: SchemaType.STRING,
					description:
						"新しいパスワード（変更する場合のみ指定。この値を以後の返信に繰り返さないこと）",
				},
				url: {
					type: SchemaType.STRING,
					description:
						"新しいログインページURL（変更する場合のみ指定。空文字を指定するとURLを削除）",
				},
			},
			required: ["service_name"],
		},
	},
	{
		name: "deleteCredential",
		description:
			"パスワードマネージャから認証情報を完全に削除します。【重要】ユーザーが明示的に削除を指示した場合のみ呼び出すこと。呼び出す前に必ず削除対象のサービス名をユーザーに復唱して確認を得ること。確認なしに勝手に削除してはいけません。削除は取り消せません。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"削除対象のサービス名（listCredentialServices で確認可能）",
				},
			},
			required: ["service_name"],
		},
	},
	{
		name: "browserFillCredential",
		description:
			"パスワードマネージャの認証情報を復号し、インタラクティブブラウザの現在のページの入力欄へ直接入力します（§6.4 get_credential 相当）。復号されたユーザー名・パスワードはブラウザにのみ渡され、LLM（あなた）には一切返されません。自動ログイン時は (1)browserInteractiveOpen でログインページを開く (2)browserInteractiveStatus で入力欄の数値IDを確認 (3)本関数で username_selector / password_selector に数値IDを指定して入力 (4)browserInteractiveClick でログインボタンを押下、の順で使ってください。セレクタには browserInteractiveStatus のマークダウンに表示される数値ID（data-yuuka-id）またはCSSセレクタを指定できます。ユーザー名のみ入力したい場合は username_selector のみ指定してください。ユーザーの明示的な指示（ログインして等）があった場合のみ使用すること。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				service_name: {
					type: SchemaType.STRING,
					description:
						"入力する認証情報のサービス名（listCredentialServices で確認可能）",
				},
				username_selector: {
					type: SchemaType.STRING,
					description:
						"ユーザー名入力欄のセレクタ（browserInteractiveStatus で確認した数値ID または CSSセレクタ）。省略時はユーザー名を入力しない",
				},
				password_selector: {
					type: SchemaType.STRING,
					description:
						"パスワード入力欄のセレクタ（browserInteractiveStatus で確認した数値ID または CSSセレクタ）。省略時はパスワードを入力しない",
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
		const services = secretService.listCredentialServices(ctx.userId);
		if (services.length === 0) {
			return JSON.stringify({
				success: true,
				message:
					"パスワードマネージャに登録済みの認証情報はありません。addCredential で登録できます。",
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
