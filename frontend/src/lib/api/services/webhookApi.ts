// webhookApi — user-scoped（scope:'user'）。src/server/routes/webhookRoutes.ts に対応。
// ハンドラは botId を読まない（ユーザースコープ）。/hook/:token は外部 Webhook 受信ルート
// で SPA 経路ではないため提供しない。
import { api } from "../client";
import type { WebhooksResponse, WebhookDeliveriesResponse, ApiResponse } from "../types";

const USER = { scope: "user" } as const;

export const webhookApi = {
	/** GET /api/webhooks — Webhook エンドポイント一覧 */
	list: () => api.get<WebhooksResponse>("/api/webhooks", USER),

	/** POST /api/webhooks/create */
	create: (body: {
		name: string;
		secret?: string;
		notifyTargetType?: "dm" | "channel";
		notifyTargetId?: string;
		template?: string;
		filterKeyword?: string;
		createTodo?: boolean;
		createReminder?: boolean;
	}) => api.post<ApiResponse>("/api/webhooks/create", body, USER),

	/** POST /api/webhooks/update */
	update: (body: { id: number; [k: string]: unknown }) =>
		api.post<ApiResponse>("/api/webhooks/update", body, USER),

	/** POST /api/webhooks/delete */
	delete: (id: number) => api.post<ApiResponse>("/api/webhooks/delete", { id }, USER),

	/** GET /api/webhooks/deliveries?endpoint_id= — 配信履歴 */
	deliveries: (endpointId?: number) =>
		api.get<WebhookDeliveriesResponse>("/api/webhooks/deliveries", {
			...USER,
			query: endpointId ? { endpoint_id: endpointId } : undefined,
		}),
};
