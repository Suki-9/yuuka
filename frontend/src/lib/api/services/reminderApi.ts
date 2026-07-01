// reminderApi — bot-scoped（scope:'bot'）。src/server/routes/reminderRoutes.ts に対応。
import { api } from "../client";
import type { RemindersResponse, ApiResponse } from "../types";

const BOT = { scope: "bot" } as const;

export const reminderApi = {
	/** GET /api/reminders — リマインダー一覧 */
	list: (query?: { status?: string }) =>
		api.get<RemindersResponse>("/api/reminders", { ...BOT, query }),

	/** POST /api/reminders/add */
	add: (body: {
		message: string;
		trigger_at: string;
		repeat_rule?: string;
		target_type?: "dm" | "channel";
		target_id?: string;
	}) => api.post<ApiResponse>("/api/reminders/add", body, BOT),

	/** POST /api/reminders/cancel */
	cancel: (id: number) => api.post<ApiResponse>("/api/reminders/cancel", { id }, BOT),
};
