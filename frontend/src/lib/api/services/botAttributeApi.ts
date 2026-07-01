// botAttributeApi — src/server/routes/botAttributeRoutes.ts に対応。
//
// ★注意: これらは全て /api/bots/* プレフィックスなので client の自動 botId 注入から
//   除外される（scope:'user'）。ハンドラは ctx.body.botId ?? query botId を自前で読むため、
//   呼び出し側が botId を明示的に渡す（GET は query、POST は body）。自動注入で上書きしない。
//   config タブ（芋づる: attributes/modules/assistant-config）が主な利用元。
import { api } from "../client";
import type { PresetsResponse, BotUsageResponse, ApiResponse } from "../types";

const USER = { scope: "user" } as const;

export const botAttributeApi = {
	/** GET /api/bots/presets */
	presets: () => api.get<PresetsResponse>("/api/bots/presets", USER),

	/** GET /api/bots/usage?botId= — 使用量（手動 botId） */
	usage: (botId: string) =>
		api.get<BotUsageResponse>("/api/bots/usage", { ...USER, query: { botId } }),

	/** POST /api/bots/attributes — Bot 属性（能力トグル等）更新 */
	updateAttributes: (body: { botId: string; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/bots/attributes", body, USER),

	/** GET /api/bots/modules?botId= — モジュール一覧 */
	modules: (botId: string) =>
		api.get<ApiResponse>("/api/bots/modules", { ...USER, query: { botId } }),
	/** POST /api/bots/modules — モジュール有効化設定 */
	updateModules: (body: { botId: string; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/bots/modules", body, USER),

	/** GET /api/bots/assistant-config?botId= — アシスタント設定一括取得 */
	assistantConfig: (botId: string) =>
		api.get<ApiResponse>("/api/bots/assistant-config", { ...USER, query: { botId } }),

	// ── assistant/* サブ設定 ──
	/** POST /api/bots/assistant/gemini-key */
	setGeminiKey: (body: { botId: string; apiKey: string }) =>
		api.post<ApiResponse>("/api/bots/assistant/gemini-key", body, USER),
	/** POST /api/bots/assistant/persona */
	setPersona: (body: { botId: string; personaId: number | null }) =>
		api.post<ApiResponse>("/api/bots/assistant/persona", body, USER),
	/** POST /api/bots/assistant/guilds */
	setGuilds: (body: { botId: string; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/bots/assistant/guilds", body, USER),
	/** POST /api/bots/assistant/members */
	setMembers: (body: { botId: string; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/bots/assistant/members", body, USER),
	/** POST /api/bots/assistant/roles */
	setRoles: (body: { botId: string; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/bots/assistant/roles", body, USER),
	/** GET /api/bots/assistant/guild-options?botId= */
	guildOptions: (botId: string) =>
		api.get<ApiResponse>("/api/bots/assistant/guild-options", { ...USER, query: { botId } }),
	/** GET /api/bots/assistant/guild-note?botId= */
	getGuildNote: (botId: string, query?: Record<string, string>) =>
		api.get<ApiResponse>("/api/bots/assistant/guild-note", {
			...USER,
			query: { botId, ...query },
		}),
	/** POST /api/bots/assistant/guild-note */
	setGuildNote: (body: { botId: string; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/bots/assistant/guild-note", body, USER),

	/** POST /api/bots/recommended-persona — 推奨ペルソナ設定（personaRoutes 側） */
	setRecommendedPersona: (body: { botId: string; personaId: number | null }) =>
		api.post<ApiResponse>("/api/bots/recommended-persona", body, USER),
};
