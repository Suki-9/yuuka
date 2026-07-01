// timelineApi — bot-scoped（scope:'bot'）。src/server/routes/timelineRoutes.ts に対応。
import { api } from "../client";
import type { TimelineDayResponse, ApiResponse } from "../types";

const BOT = { scope: "bot" } as const;

export const timelineApi = {
	/** GET /api/timeline/day?date=YYYY-MM-DD — その日の plan + records */
	day: (date: string) =>
		api.get<TimelineDayResponse>("/api/timeline/day", { ...BOT, query: { date } }),

	/** POST /api/timeline/plan — 予定ブロック追加 */
	addPlan: (body: Record<string, unknown>) =>
		api.post<ApiResponse>("/api/timeline/plan", body, BOT),

	/** POST /api/timeline/plan/update */
	updatePlan: (body: Record<string, unknown>) =>
		api.post<ApiResponse>("/api/timeline/plan/update", body, BOT),

	/** POST /api/timeline/plan/delete */
	deletePlan: (id: number) => api.post<ApiResponse>("/api/timeline/plan/delete", { id }, BOT),

	/** POST /api/timeline/record — 記録（memo/expense/media 等）追加 */
	addRecord: (body: Record<string, unknown>) =>
		api.post<ApiResponse>("/api/timeline/record", body, BOT),

	/** POST /api/timeline/record/delete */
	deleteRecord: (id: number) =>
		api.post<ApiResponse>("/api/timeline/record/delete", { id }, BOT),

	/**
	 * POST /api/timeline/media — メディアアップロード（multipart）。
	 * FormData を渡すと client が Content-Type を委ね botId は query へ回す。
	 */
	uploadMedia: (form: FormData) => api.post<ApiResponse>("/api/timeline/media", form, BOT),

	/** GET /api/timeline/media/:filename の URL を組み立てるヘルパ（画像 src 用） */
	mediaUrl: (filename: string) => `/api/timeline/media/${encodeURIComponent(filename)}`,
};
