// authApi — user-scoped（scope:'user'）。src/server/routes/authRoutes.ts に対応。
// /api/login|register|logout|me|setup* は botId 除外（プレフィックス一致）。
import { api } from "../client";
import type {
	MeResponse,
	SetupStatusResponse,
	LoginResponse,
	RegisterResponse,
	ApiResponse,
} from "../types";

const USER = { scope: "user" } as const;

export const authApi = {
	/**
	 * GET /api/me — セッションの単一の真実。未ログインで 401。
	 * 起動時プローブは isBootstrap:true を渡し 401 でも /login へ遷移させない。
	 */
	me: (isBootstrap = false) =>
		api.get<MeResponse>("/api/me", { ...USER, isBootstrap }),

	/** GET /api/setup/status — 共通エンベロープ外（success を持たない） */
	setupStatus: () =>
		api.get<SetupStatusResponse>("/api/setup/status", { ...USER, isBootstrap: true }),

	/** POST /api/setup — 初期セットアップ（最初のユーザー＝管理者登録） */
	setup: (body: {
		discordId: string;
		username: string;
		password: string;
		geminiApiKey: string;
	}) => api.post<ApiResponse>("/api/setup", body, USER),

	/** POST /api/login */
	login: (body: { username: string; password: string }) =>
		api.post<LoginResponse>("/api/login", body, USER),

	/** POST /api/register — DM チャレンジ発行 */
	register: (body: {
		discordId: string;
		username: string;
		password: string;
		inviteCode?: string;
	}) => api.post<RegisterResponse>("/api/register", body, USER),

	/** POST /api/register/verify — DM チャレンジ確定 */
	registerVerify: (body: { challengeId: string; code: string }) =>
		api.post<ApiResponse>("/api/register/verify", body, USER),

	/** POST /api/logout */
	logout: () => api.post<ApiResponse>("/api/logout", {}, USER),
};
