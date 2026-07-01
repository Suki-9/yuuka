// playbookApi — bot-scoped（scope:'bot'）。src/server/routes/playbookRoutes.ts に対応。
import { api } from "../client";
import type {
	PlaybooksResponse,
	PlaybookSchedulesResponse,
	PlaybookRunsResponse,
	ApiResponse,
} from "../types";

const BOT = { scope: "bot" } as const;

export const playbookApi = {
	/** GET /api/playbooks */
	list: () => api.get<PlaybooksResponse>("/api/playbooks", BOT),
	/** POST /api/playbooks/save */
	save: (body: { id?: number; name: string; content: string }) =>
		api.post<ApiResponse>("/api/playbooks/save", body, BOT),
	/** POST /api/playbooks/delete */
	delete: (id: number) => api.post<ApiResponse>("/api/playbooks/delete", { id }, BOT),

	// ── スケジュール（定期実行） ──
	/** GET /api/playbooks/schedules */
	schedules: () => api.get<PlaybookSchedulesResponse>("/api/playbooks/schedules", BOT),
	/** POST /api/playbooks/schedules/save */
	saveSchedule: (body: { id?: number; playbook_id: number; cron: string }) =>
		api.post<ApiResponse>("/api/playbooks/schedules/save", body, BOT),
	/** POST /api/playbooks/schedules/toggle */
	toggleSchedule: (body: { id: number; enabled: boolean }) =>
		api.post<ApiResponse>("/api/playbooks/schedules/toggle", body, BOT),
	/** POST /api/playbooks/schedules/delete */
	deleteSchedule: (id: number) =>
		api.post<ApiResponse>("/api/playbooks/schedules/delete", { id }, BOT),

	/** GET /api/playbooks/runs — 実行履歴 */
	runs: (query?: { playbook_id?: number }) =>
		api.get<PlaybookRunsResponse>("/api/playbooks/runs", {
			...BOT,
			query: query?.playbook_id ? { playbook_id: query.playbook_id } : undefined,
		}),
};
