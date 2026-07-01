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
	PersonaMarketplaceDetailResponse,
	ApiResponse,
} from "../types";

const USER = { scope: "user" } as const;
const BOT = { scope: "bot" } as const;

export const personaApi = {
	/** GET /api/personas — 自分のペルソナ一覧＋適用中ID＋最大文字数（bot-scoped: active 判定に botId を読む） */
	list: () => api.get<PersonasResponse>("/api/personas", BOT),

	/** POST /api/personas/save（body は { id?, name, prompt }） */
	save: (body: { id?: number; name: string; prompt: string }) =>
		api.post<ApiResponse>("/api/personas/save", body, USER),
	/** POST /api/personas/delete */
	delete: (id: number) => api.post<ApiResponse>("/api/personas/delete", { id }, USER),

	/** POST /api/personas/activate — 適用中ペルソナ切替（bot-scoped。null でデフォルトへ戻す） */
	activate: (id: number | null) =>
		api.post<ApiResponse>("/api/personas/activate", { id }, BOT),

	/** POST /api/personas/publish — 公開/非公開の切替（サーバは { id, isPublic } を読む） */
	publish: (id: number, isPublic: boolean) =>
		api.post<ApiResponse>("/api/personas/publish", { id, isPublic }, USER),

	/** GET /api/personas/marketplace — 公開ペルソナ一覧 */
	marketplace: () =>
		api.get<PersonaMarketplaceResponse>("/api/personas/marketplace", USER),
	/** GET /api/personas/marketplace/:id — 公開ペルソナ全文（インポート判断用） */
	marketplaceDetail: (id: number) =>
		api.get<PersonaMarketplaceDetailResponse>(
			`/api/personas/marketplace/${id}`,
			USER,
		),
	/** POST /api/personas/import — 公開ペルソナを自分のものへ独立コピー（サーバは { id } を読む） */
	import: (id: number) => api.post<ApiResponse>("/api/personas/import", { id }, USER),
};
