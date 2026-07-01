// adminApi — user-scoped（scope:'user'、全ルート auth:'admin'）。
// src/server/routes/adminRoutes.ts / botAttributeRoutes.ts(admin) / personaRoutes.ts(admin) に対応。
// botId は付けない。
import { api } from "../client";
import type {
	AdminStatsResponse,
	AdminUsersResponse,
	AdminBotsResponse,
	AdminInviteCodesResponse,
	AdminAuditLogsResponse,
	AdminSystemSettingsResponse,
	ApiResponse,
} from "../types";

const USER = { scope: "user" } as const;

export const adminApi = {
	/** POST /api/admin/default-bot/token — system_default Bot のトークン設定 */
	setDefaultBotToken: (body: { token: string }) =>
		api.post<ApiResponse>("/api/admin/default-bot/token", body, USER),

	/** GET /api/admin/stats */
	stats: () => api.get<AdminStatsResponse>("/api/admin/stats", USER),

	// ── システム設定 ──
	/** GET /api/admin/system-settings */
	systemSettings: () =>
		api.get<AdminSystemSettingsResponse>("/api/admin/system-settings", USER),
	/** POST /api/admin/system-settings */
	saveSystemSettings: (body: Record<string, unknown>) =>
		api.post<ApiResponse>("/api/admin/system-settings", body, USER),

	// ── ユーザー管理 ──
	/** GET /api/admin/users */
	users: () => api.get<AdminUsersResponse>("/api/admin/users", USER),
	/** POST /api/admin/users/role */
	setUserRole: (body: { discordId: string; role: "user" | "admin" }) =>
		api.post<ApiResponse>("/api/admin/users/role", body, USER),
	/** POST /api/admin/users/delete */
	deleteUser: (discordId: string) =>
		api.post<ApiResponse>("/api/admin/users/delete", { discordId }, USER),

	/** GET /api/admin/audit-logs */
	auditLogs: (query?: { limit?: number; offset?: number }) =>
		api.get<AdminAuditLogsResponse>("/api/admin/audit-logs", {
			...USER,
			query: {
				limit: query?.limit,
				offset: query?.offset,
			},
		}),

	// ── Bot 管理 ──
	/** GET /api/admin/bots */
	bots: () => api.get<AdminBotsResponse>("/api/admin/bots", USER),
	/** POST /api/admin/bots/suspend */
	suspendBot: (botId: string) =>
		api.post<ApiResponse>("/api/admin/bots/suspend", { botId }, USER),
	/** POST /api/admin/bots/unsuspend */
	unsuspendBot: (botId: string) =>
		api.post<ApiResponse>("/api/admin/bots/unsuspend", { botId }, USER),

	// ── 招待コード ──
	/** GET /api/admin/invite-codes */
	inviteCodes: () => api.get<AdminInviteCodesResponse>("/api/admin/invite-codes", USER),
	/** POST /api/admin/invite-codes — 発行 */
	createInviteCode: (body?: Record<string, unknown>) =>
		api.post<ApiResponse>("/api/admin/invite-codes", body ?? {}, USER),
	/** POST /api/admin/invite-codes/:code/revoke */
	revokeInviteCode: (code: string) =>
		api.post<ApiResponse>(
			`/api/admin/invite-codes/${encodeURIComponent(code)}/revoke`,
			{},
			USER,
		),
	/** DELETE /api/admin/invite-codes/:code */
	deleteInviteCode: (code: string) =>
		api.del<ApiResponse>(`/api/admin/invite-codes/${encodeURIComponent(code)}`, USER),

	// ── Bot 属性のグローバル既定（botAttributeRoutes: admin） ──
	/** GET /api/admin/bot-attribute-settings */
	botAttributeSettings: () =>
		api.get<ApiResponse>("/api/admin/bot-attribute-settings", USER),
	/** POST /api/admin/bot-attribute-settings */
	saveBotAttributeSettings: (body: Record<string, unknown>) =>
		api.post<ApiResponse>("/api/admin/bot-attribute-settings", body, USER),

	// ── ペルソナ管理（personaRoutes: admin） ──
	/** POST /api/admin/personas/unpublish */
	unpublishPersona: (id: number) =>
		api.post<ApiResponse>("/api/admin/personas/unpublish", { id }, USER),
	/** POST /api/admin/personas/delete */
	deletePersona: (id: number) =>
		api.post<ApiResponse>("/api/admin/personas/delete", { id }, USER),
};
