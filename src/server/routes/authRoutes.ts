import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import { config } from "../../config.js";
import {
	setSessionCookie,
	getSessionToken,
	getClientIp,
} from "../httpHelpers.js";
import {
	createSession,
	destroySession,
} from "../../services/sessionService.js";
import { validatePassword } from "../../services/passwordPolicy.js";
import {
	createUser,
	getUserByDiscordId,
	verifyPasswordConstantTime,
	listAllUsers,
} from "../../db/userRepo.js";
import { isValidCode, validateAndConsumeCode } from "../../db/inviteRepo.js";
import {
	createPendingRegistration,
	verifyPendingRegistration,
} from "../../services/pendingRegistration.js";
import { sendRegistrationCodeDM } from "../../bot.js";
import { encryptText } from "../../utils/crypto.js";
import { updateUserGeminiSettings } from "../../db/userRepo.js";
import { addAuditLog } from "../../db/auditRepo.js";
import { getSystemSetting } from "../../db/systemSettingsRepo.js";

// ─── 認証・登録 HTTPルート（§5.4） ───────────────────────────────────────────

// ログイン試行レート制限（(クライアントIP, アカウント) 単位）。
// プロキシ配下では getClientIp が実クライアントIPを解決する。アカウントも鍵に含めることで
// 1つのIPから全アカウントを巻き込んでロックアウトする攻撃を防ぐ。
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15分間ロックアウト

// 失効済みエントリの定期掃除（無制限な肥大によるメモリ枯渇を防ぐ。unrefでプロセス終了を妨げない）
setInterval(
	() => {
		const now = Date.now();
		for (const [key, a] of loginAttempts.entries()) {
			if (a.resetAt <= now) loginAttempts.delete(key);
		}
	},
	5 * 60 * 1000,
).unref();

/** Discord ID（snowflake）の形式検証: 数字のみ・17〜20桁 */
function isValidDiscordId(s: string): boolean {
	return /^\d{17,20}$/.test(s);
}

// 登録確認コードのDM送信レート制限（被害者DMスパム・列挙の防止。(IP, discordId) 単位）
const registerSendAttempts = new Map<
	string,
	{ count: number; resetAt: number }
>();
const MAX_REGISTER_SENDS = 5;
const REGISTER_WINDOW_MS = 15 * 60 * 1000;

setInterval(
	() => {
		const now = Date.now();
		for (const [k, a] of registerSendAttempts.entries()) {
			if (a.resetAt <= now) registerSendAttempts.delete(k);
		}
	},
	5 * 60 * 1000,
).unref();

/** 登録コード送信のレート制限を消費する。上限超過なら false。 */
function allowRegisterSend(key: string): boolean {
	const now = Date.now();
	const a = registerSendAttempts.get(key);
	if (!a || a.resetAt <= now) {
		registerSendAttempts.set(key, {
			count: 1,
			resetAt: now + REGISTER_WINDOW_MS,
		});
		return true;
	}
	if (a.count >= MAX_REGISTER_SENDS) return false;
	a.count += 1;
	return true;
}

function publicLegalUrls(): { privacyPolicyUrl: string; termsUrl: string } {
	return {
		privacyPolicyUrl:
			getSystemSetting("privacy_policy_url") || config.privacyPolicyUrl,
		termsUrl: getSystemSetting("terms_url") || config.termsUrl,
	};
}

export const authRoutes: RouteDef[] = [
	// ── セットアップ状態の確認 ──
	{
		method: "GET",
		path: "/api/setup/status",
		auth: "none",
		async handler(ctx) {
			const users = listAllUsers();
			sendJson(ctx.res, 200, {
				needSetup: users.length === 0,
				...publicLegalUrls(),
			});
		},
	},

	// ── 初期セットアップ実行（最初のユーザー＝管理者登録） ──
	{
		method: "POST",
		path: "/api/setup",
		auth: "none",
		async handler(ctx) {
			const users = listAllUsers();
			if (users.length > 0) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "システムは既にセットアップされています。",
				});
			}

			const { discordId, username, password, geminiApiKey } =
				ctx.body as Record<string, string>;
			if (!discordId || !username || !password || !geminiApiKey) {
				return sendJson(ctx.res, 400, {
					success: false,
					message:
						"すべてのフィールド（Discord ID、ユーザーネーム、パスワード、Gemini API Key）を入力してください。",
				});
			}

			// パスワードポリシー検証（§5.4.3）
			const policy = validatePassword(password);
			if (!policy.ok) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: policy.reason || "パスワードがポリシーを満たしていません。",
				});
			}

			const cleanDiscordId = discordId.trim();
			const cleanUsername = username.trim();

			// 入力検証（§5.4）
			if (!isValidDiscordId(cleanDiscordId)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "Discord ID の形式が不正です（17〜20桁の数字）。",
				});
			}
			if (cleanUsername.length > 64) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "ユーザーネームは64文字以内で入力してください。",
				});
			}

			// 1. 管理者ユーザーの登録 (最初の登録なので自動的に admin ロールになる)
			const user = createUser(cleanDiscordId, cleanUsername, password);

			// 2. Gemini APIキーの登録（暗号化保存 §4.2）
			const enc = encryptText(geminiApiKey.trim());
			updateUserGeminiSettings(
				cleanDiscordId,
				enc.encrypted,
				enc.iv,
				enc.authTag,
				"gemini-3.1-flash-lite",
			);

			// 3. セッショントークン生成と自動ログイン
			const sessionToken = await createSession({
				discordId: user.discord_id,
				username: user.username,
				role: user.role as "user" | "admin",
			});
			addAuditLog(cleanDiscordId, "auth.register", "initial_setup");

			setSessionCookie(ctx.res, ctx.req, sessionToken);
			sendJson(ctx.res, 200, {
				success: true,
				message:
					"管理者登録が完了しました。続いてデフォルトBotを設定してください。",
			});
		},
	},

	// ── 新規登録（招待コード必須） ──
	{
		method: "POST",
		path: "/api/register",
		auth: "none",
		async handler(ctx) {
			const { discordId, username, password, inviteCode, geminiApiKey } =
				ctx.body as Record<string, string>;
			if (
				!discordId ||
				!username ||
				!password ||
				!inviteCode ||
				!geminiApiKey
			) {
				return sendJson(ctx.res, 400, {
					success: false,
					message:
						"すべてのフィールド（Discord ID、ユーザーネーム、パスワード、招待コード、Gemini API Key）を入力してください。",
				});
			}

			const cleanDiscordId = discordId.trim();
			const cleanUsername = username.trim();

			// 入力検証（§5.4）
			if (!isValidDiscordId(cleanDiscordId)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "Discord ID の形式が不正です（17〜20桁の数字）。",
				});
			}
			if (cleanUsername.length > 64) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "ユーザーネームは64文字以内で入力してください。",
				});
			}

			if (getUserByDiscordId(cleanDiscordId)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "このDiscord IDは既に登録されています。",
				});
			}

			// パスワードポリシー検証（§5.4.3）
			const policy = validatePassword(password);
			if (!policy.ok) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: policy.reason || "パスワードがポリシーを満たしていません。",
				});
			}

			// 招待コードは事前検証のみ（消費は本人確認後）。無効ならDMを送らない。
			if (!isValidCode(inviteCode.trim())) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "無効な、または使用済みの招待コードです。",
				});
			}

			// DMスパム・ID列挙の防止
			const sendKey = `${getClientIp(ctx.req)}|${cleanDiscordId}`;
			if (!allowRegisterSend(sendKey)) {
				return sendJson(ctx.res, 429, {
					success: false,
					message:
						"確認コードの送信回数が上限に達しました。しばらくしてから再度お試しください。",
				});
			}

			// G1対策（DMチャレンジ）: 主張された Discord ID 宛にワンタイムコードをDMし、本人確認後にのみ作成する。
			const code = createPendingRegistration(cleanDiscordId, {
				username: cleanUsername,
				password,
				geminiApiKey: geminiApiKey.trim(),
				inviteCode: inviteCode.trim(),
			});
			const dmSent = await sendRegistrationCodeDM(cleanDiscordId, code);
			if (!dmSent) {
				return sendJson(ctx.res, 502, {
					success: false,
					message:
						"確認コードのDM送信に失敗しました。Botと同じDiscordサーバーに参加し、DMの受信を許可した上で再度お試しください。",
				});
			}

			sendJson(ctx.res, 200, {
				success: true,
				pending: true,
				message:
					"確認コードをDiscordのDMに送信しました。10分以内にコードを入力して登録を完了してください。",
			});
		},
	},

	// ── 登録の本人確認（DMで送ったワンタイムコードの検証 → 実ユーザー作成。G1対策） ──
	{
		method: "POST",
		path: "/api/register/verify",
		auth: "none",
		async handler(ctx) {
			const { discordId, code } = ctx.body as Record<string, string>;
			if (!discordId || !code) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "Discord ID と確認コードを入力してください。",
				});
			}
			const cleanDiscordId = discordId.trim();

			const result = verifyPendingRegistration(
				cleanDiscordId,
				String(code).trim(),
			);
			if (!result.ok) {
				const message =
					result.reason === "not_found"
						? "登録手続きが見つかりません。最初からやり直してください。"
						: result.reason === "expired"
							? "確認コードの有効期限が切れました。最初からやり直してください。"
							: result.reason === "too_many_attempts"
								? "確認コードの試行回数が上限に達しました。最初からやり直してください。"
								: "確認コードが正しくありません。";
				return sendJson(ctx.res, 400, { success: false, message });
			}

			const { username, password, geminiApiKey, inviteCode } = result.data;

			// 確認中に他経路で同IDが登録された場合の保護
			if (getUserByDiscordId(cleanDiscordId)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "このDiscord IDは既に登録されています。",
				});
			}
			// 招待コードをアトミックに消費（本人確認後）
			if (!validateAndConsumeCode(inviteCode, cleanDiscordId)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "無効な、または使用済みの招待コードです。",
				});
			}

			// ユーザー作成（salt自動生成 §6.2）
			createUser(cleanDiscordId, username, password);
			// Gemini APIキーの登録（暗号化保存 §4.2）
			const enc = encryptText(geminiApiKey);
			updateUserGeminiSettings(
				cleanDiscordId,
				enc.encrypted,
				enc.iv,
				enc.authTag,
				"gemini-3.1-flash-lite",
			);
			addAuditLog(cleanDiscordId, "auth.register");

			sendJson(ctx.res, 200, {
				success: true,
				message: "登録が完了しました！ログインしてください。",
			});
		},
	},

	// ── ログイン ──
	{
		method: "POST",
		path: "/api/login",
		auth: "none",
		async handler(ctx) {
			const clientIp = getClientIp(ctx.req);

			const { discordId, password } = ctx.body as Record<string, string>;
			if (!discordId || !password) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "Discord ID とパスワードを入力してください。",
				});
			}

			const cleanDiscordId = discordId.trim();
			// レート制限は (IP, アカウント) 単位。1つのIPから全アカウントを巻き込まない。
			const rlKey = `${clientIp}|${cleanDiscordId}`;

			const attempt = loginAttempts.get(rlKey);
			if (
				attempt &&
				attempt.count >= MAX_LOGIN_ATTEMPTS &&
				Date.now() < attempt.resetAt
			) {
				const remainSec = Math.ceil((attempt.resetAt - Date.now()) / 1000);
				return sendJson(ctx.res, 429, {
					success: false,
					message: `ログイン試行回数が上限に達しました。${remainSec}秒後に再試行してください。`,
				});
			}

			const user = getUserByDiscordId(cleanDiscordId);

			// タイミングオラクル対策: ユーザー不在でも一定の bcrypt 比較時間を消費し、
			// 応答時間差による Discord ID の存在判定（アカウント列挙）を防ぐ。
			const passwordOk = verifyPasswordConstantTime(
				password,
				user?.password_hash,
			);

			if (user && passwordOk) {
				// ログイン成功：試行カウントをリセット
				loginAttempts.delete(rlKey);

				// Redisセッション発行（7日スライディングウィンドウ §5.4.2）
				const sessionToken = await createSession({
					discordId: user.discord_id,
					username: user.username,
					role: (user.role as "user" | "admin") || "user",
				});
				addAuditLog(cleanDiscordId, "auth.login");

				setSessionCookie(ctx.res, ctx.req, sessionToken);
				sendJson(ctx.res, 200, {
					success: true,
					message: "ログインに成功しました！",
				});
			} else {
				// ログイン失敗。ロック期間中は resetAt を延長せず（毎回延ばさない）、新しい窓のみ開始する。
				const now = Date.now();
				const current = loginAttempts.get(rlKey);
				if (!current || current.resetAt <= now) {
					loginAttempts.set(rlKey, {
						count: 1,
						resetAt: now + LOGIN_LOCKOUT_MS,
					});
				} else {
					current.count += 1;
				}

				if (user) {
					addAuditLog(cleanDiscordId, "auth.login_failed");
				}
				sendJson(ctx.res, 401, {
					success: false,
					message: "Discord ID またはパスワードが正しくありません。",
				});
			}
		},
	},

	// ── ログアウト ──
	{
		method: "POST",
		path: "/api/logout",
		auth: "user",
		async handler(ctx) {
			const token = getSessionToken(ctx.req);
			if (token) {
				await destroySession(token);
			}
			setSessionCookie(ctx.res, ctx.req, "", 0);
			sendJson(ctx.res, 200, {
				success: true,
				message: "ログアウトしました。",
			});
		},
	},

	// ── 自分自身の情報取得 ──
	{
		method: "GET",
		path: "/api/me",
		auth: "user",
		async handler(ctx) {
			const user = getUserByDiscordId(ctx.user!.discordId);
			if (!user) {
				return sendJson(ctx.res, 404, {
					success: false,
					message: "ユーザーが見つかりません。",
				});
			}
			sendJson(ctx.res, 200, {
				success: true,
				user: {
					discordId: user.discord_id,
					username: user.username,
					role: user.role || "user",
				},
				...publicLegalUrls(),
			});
		},
	},

	// ── ユニークユーザーリスト (互換性のために自身の情報のみを返す) ──
	{
		method: "GET",
		path: "/api/users",
		auth: "user",
		async handler(ctx) {
			const user = getUserByDiscordId(ctx.user!.discordId);
			sendJson(ctx.res, 200, {
				success: true,
				users: user ? [user.username] : [],
			});
		},
	},
];
