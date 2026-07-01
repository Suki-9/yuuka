// scheduleApi — bot-scoped（scope:'bot'）。src/server/routes/scheduleRoutes.ts に対応。
import { api } from "../client";
import type { SchedulesResponse, ApiResponse } from "../types";

const BOT = { scope: "bot" } as const;

export const scheduleApi = {
	/** GET /api/schedules — 予定一覧 */
	list: (query?: { from?: string; to?: string }) =>
		api.get<SchedulesResponse>("/api/schedules", { ...BOT, query }),

	/** POST /api/schedules/add */
	add: (body: {
		title: string;
		description?: string;
		start_at: string;
		end_at?: string;
		remind_before_minutes?: number;
	}) => api.post<ApiResponse>("/api/schedules/add", body, BOT),

	/** POST /api/schedules/delete */
	delete: (id: number) => api.post<ApiResponse>("/api/schedules/delete", { id }, BOT),
};
