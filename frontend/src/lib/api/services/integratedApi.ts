// integratedApi — src/server/routes/integratedRoutes.ts に対応。
//
// overview は非スコープ（全 Bot 横断）だが、bot 操作系（start/stop/restart/clear-history）
// と grants 系は body.botId を読む。ただし呼び出し側が対象 botId を明示的に渡す設計のため、
// activeBot への自動フォールバックは望ましくない → scope:'user' で botId を body に明示。
import { api } from "../client";
import type { IntegratedOverviewResponse, ApiResponse } from "../types";

const USER = { scope: "user" } as const;

export const integratedApi = {
	/** GET /api/integrated/overview — 全 Bot 横断の統合ビュー */
	overview: () => api.get<IntegratedOverviewResponse>("/api/integrated/overview", USER),

	// ── Bot ライフサイクル操作（対象 botId を明示） ──
	/** POST /api/integrated/bots/start */
	startBot: (botId: string) =>
		api.post<ApiResponse>("/api/integrated/bots/start", { botId }, USER),
	/** POST /api/integrated/bots/stop */
	stopBot: (botId: string) =>
		api.post<ApiResponse>("/api/integrated/bots/stop", { botId }, USER),
	/** POST /api/integrated/bots/restart */
	restartBot: (botId: string) =>
		api.post<ApiResponse>("/api/integrated/bots/restart", { botId }, USER),
	/** POST /api/integrated/bots/clear-history */
	clearHistory: (botId: string) =>
		api.post<ApiResponse>("/api/integrated/bots/clear-history", { botId }, USER),

	// ── 許可付与（grants） ──
	/** POST /api/integrated/grants/mcp */
	grantMcp: (body: { botId: string; serverId: number; grant: boolean }) =>
		api.post<ApiResponse>("/api/integrated/grants/mcp", body, USER),
	/** POST /api/integrated/grants/credential */
	grantCredential: (body: { botId: string; name: string; grant: boolean }) =>
		api.post<ApiResponse>("/api/integrated/grants/credential", body, USER),
	/** POST /api/integrated/grants/google */
	grantGoogle: (body: { botId: string; accountId: string; grant: boolean }) =>
		api.post<ApiResponse>("/api/integrated/grants/google", body, USER),

	// ── Google アカウント管理 ──
	/** POST /api/integrated/google/accounts/primary */
	setPrimaryGoogleAccount: (accountId: string) =>
		api.post<ApiResponse>("/api/integrated/google/accounts/primary", { accountId }, USER),
	/** POST /api/integrated/google/accounts/delete */
	deleteGoogleAccount: (accountId: string) =>
		api.post<ApiResponse>("/api/integrated/google/accounts/delete", { accountId }, USER),
	/** POST /api/integrated/google/accounts/calendars — 同期カレンダー設定 */
	setGoogleCalendars: (body: { accountId: string; calendars: string[] }) =>
		api.post<ApiResponse>("/api/integrated/google/accounts/calendars", body, USER),
	/** GET /api/integrated/google/accounts/:id/calendars — カレンダー一覧取得 */
	googleAccountCalendars: (accountId: string) =>
		api.get<ApiResponse>(`/api/integrated/google/accounts/${accountId}/calendars`, USER),
};
