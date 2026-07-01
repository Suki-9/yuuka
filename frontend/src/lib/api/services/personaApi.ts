// personaApi — src/server/routes/personaRoutes.ts に対応。
//
// スコープ混在に注意（ハンドラの botId 読み取りに実挙動を合わせる）:
//   - list（GET /api/personas）と activate（POST /api/personas/activate）は
//     resolveScopedBotId で botId を読む → scope:'bot'。
//   - save/delete/publish/marketplace/import は botId を読まない → scope:'user'。
import { api } from "../client";
import type {
	PersonasResponse,
	PersonaMarketplaceResponse,
	ApiResponse,
} from "../types";

const USER = { scope: "user" } as const;
const BOT = { scope: "bot" } as const;

export const personaApi = {
	/** GET /api/personas — 自分のペルソナ一覧（bot-scoped: active 判定に botId を読む） */
	list: () => api.get<PersonasResponse>("/api/personas", BOT),

	/** POST /api/personas/save */
	save: (body: { id?: number; name: string; prompt: string }) =>
		api.post<ApiResponse>("/api/personas/save", body, USER),
	/** POST /api/personas/delete */
	delete: (id: number) => api.post<ApiResponse>("/api/personas/delete", { id }, USER),

	/** POST /api/personas/activate — 適用中ペルソナ切替（bot-scoped） */
	activate: (id: number | null) =>
		api.post<ApiResponse>("/api/personas/activate", { id }, BOT),

	/** POST /api/personas/publish — マーケットプレイスへ公開 */
	publish: (id: number) => api.post<ApiResponse>("/api/personas/publish", { id }, USER),

	/** GET /api/personas/marketplace — 公開ペルソナ一覧 */
	marketplace: () =>
		api.get<PersonaMarketplaceResponse>("/api/personas/marketplace", USER),
	/** GET /api/personas/marketplace/:id — 公開ペルソナ詳細 */
	marketplaceDetail: (id: number) =>
		api.get<ApiResponse>(`/api/personas/marketplace/${id}`, USER),
	/** POST /api/personas/import — 公開ペルソナを自分のものへ取り込み */
	import: (marketplaceId: number) =>
		api.post<ApiResponse>("/api/personas/import", { marketplaceId }, USER),
};
