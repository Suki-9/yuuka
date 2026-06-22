import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
	createEndpoint,
	getEndpointById,
	getEndpointByToken,
	listEndpoints,
	updateEndpoint,
	deleteEndpoint,
	listDeliveries,
	toEndpointView,
} from "../../db/webhookRepo.js";
import { processIncomingWebhook } from "../../services/webhookProcessor.js";
import { config } from "../../config.js";

// ─── Webhook HTTPルート（§3.13） ─────────────────────────────────────────────
// 受信: POST /hook/:token（auth:"none"。即時応答後に非同期処理し外部サービスを待たせない）
// 管理: /api/webhooks/*（auth:"user"）

/** エンドポイントの完全なURL（外部サービスに登録するURL）を構築する */
function buildHookUrl(token: string): string {
	const base = config.baseUrl ? config.baseUrl.replace(/\/$/, "") : "";
	return base ? `${base}/hook/${token}` : `/hook/${token}`;
}

// ── 受信レート制限（トークン単位・毎分上限。LLM呼び出しコストの増幅・スパム防止） ──
const RATE_LIMIT_PER_MINUTE = 30;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(token: string): boolean {
	const now = Date.now();
	const bucket = rateBuckets.get(token);
	if (!bucket || bucket.resetAt <= now) {
		rateBuckets.set(token, { count: 1, resetAt: now + 60_000 });
		return true;
	}
	bucket.count += 1;
	return bucket.count <= RATE_LIMIT_PER_MINUTE;
}

// 古いバケットの定期掃除（メモリリーク防止）
setInterval(() => {
	const now = Date.now();
	for (const [key, bucket] of rateBuckets.entries()) {
		if (bucket.resetAt <= now) rateBuckets.delete(key);
	}
}, 5 * 60_000).unref();

export const webhookRoutes: RouteDef[] = [
	// ── 受信エンドポイント（公開 §3.13.2） ──
	{
		method: "POST",
		path: "/hook/:token",
		auth: "none",
		async handler(ctx) {
			if (!checkRateLimit(ctx.params.token)) {
				return sendJson(ctx.res, 429, {
					success: false,
					message: "rate limited",
				});
			}
			const endpoint = getEndpointByToken(ctx.params.token);
			if (!endpoint) {
				return sendJson(ctx.res, 404, { success: false, message: "not found" });
			}
			if (endpoint.enabled !== 1) {
				return sendJson(ctx.res, 410, {
					success: false,
					message: "endpoint disabled",
				});
			}

			// 即時200応答（Discord通知やLLM解釈の遅延で外部サービスをタイムアウトさせない）
			sendJson(ctx.res, 200, { success: true, message: "accepted" });

			const signatureHeader =
				(ctx.req.headers["x-hub-signature-256"] as string | undefined) ??
				(ctx.req.headers["x-signature-256"] as string | undefined) ??
				(ctx.req.headers["x-hub-signature"] as string | undefined);

			// 非同期で処理（エラーは内部ログと監査記録に残る）
			processIncomingWebhook(endpoint, ctx.rawBody, signatureHeader).catch(
				(err) => {
					console.error(
						`[Webhook] 受信処理で予期しないエラー (endpoint: ${endpoint.name}):`,
						err,
					);
				},
			);
		},
	},

	// ── 一覧 ──
	{
		method: "GET",
		path: "/api/webhooks",
		auth: "user",
		async handler(ctx) {
			const endpoints = listEndpoints(ctx.user!.discordId).map((e) => ({
				...toEndpointView(e),
				url: buildHookUrl(e.token),
			}));
			sendJson(ctx.res, 200, { success: true, endpoints });
		},
	},

	// ── 作成 ──
	{
		method: "POST",
		path: "/api/webhooks/create",
		auth: "user",
		async handler(ctx) {
			const name =
				typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
			if (!name) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "name は必須です。",
				});
			}
			// セキュリティ: 署名検証を必須化するため、シークレットを必須にする（未署名受信を拒否）
			const secret =
				typeof ctx.body.secret === "string" ? ctx.body.secret.trim() : "";
			if (secret.length < 16) {
				return sendJson(ctx.res, 400, {
					success: false,
					message:
						"Webhookシークレット（16文字以上）は必須です。受信は HMAC-SHA256 署名で検証されます。",
				});
			}

			const endpoint = createEndpoint(ctx.user!.discordId, {
				name,
				secret,
				notifyTargetType:
					ctx.body.notifyTargetType === "channel" ? "channel" : "dm",
				notifyTargetId:
					typeof ctx.body.notifyTargetId === "string" &&
					ctx.body.notifyTargetId.trim()
						? ctx.body.notifyTargetId.trim()
						: null,
				template:
					typeof ctx.body.template === "string" ? ctx.body.template : null,
				filterKeyword:
					typeof ctx.body.filterKeyword === "string"
						? ctx.body.filterKeyword
						: null,
				createTodo: ctx.body.createTodo === true,
				createReminder: ctx.body.createReminder === true,
			});

			sendJson(ctx.res, 200, {
				success: true,
				endpoint: {
					...toEndpointView(endpoint),
					url: buildHookUrl(endpoint.token),
				},
				message: `Webhookエンドポイント「${name}」を作成しました。発行されたURLを外部サービスに登録してください。`,
			});
		},
	},

	// ── 更新（有効/無効・テンプレート・フィルタ等） ──
	{
		method: "POST",
		path: "/api/webhooks/update",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			// セキュリティ: シークレットを更新する場合は16文字以上を要求し、空へのクリアは許可しない
			if (ctx.body.secret !== undefined) {
				const s =
					typeof ctx.body.secret === "string" ? ctx.body.secret.trim() : "";
				if (s.length < 16) {
					return sendJson(ctx.res, 400, {
						success: false,
						message:
							"Webhookシークレットは16文字以上が必要です（署名検証のため空にはできません）。",
					});
				}
			}

			const ok = updateEndpoint(ctx.user!.discordId, id, {
				...(typeof ctx.body.name === "string" && ctx.body.name.trim()
					? { name: ctx.body.name }
					: {}),
				...(ctx.body.secret !== undefined
					? {
							secret:
								typeof ctx.body.secret === "string"
									? ctx.body.secret.trim()
									: null,
						}
					: {}),
				...(ctx.body.notifyTargetType !== undefined
					? {
							notifyTargetType:
								ctx.body.notifyTargetType === "channel"
									? ("channel" as const)
									: ("dm" as const),
						}
					: {}),
				...(ctx.body.notifyTargetId !== undefined
					? {
							notifyTargetId:
								typeof ctx.body.notifyTargetId === "string" &&
								ctx.body.notifyTargetId.trim()
									? ctx.body.notifyTargetId.trim()
									: null,
						}
					: {}),
				...(ctx.body.template !== undefined
					? {
							template:
								typeof ctx.body.template === "string"
									? ctx.body.template
									: null,
						}
					: {}),
				...(ctx.body.filterKeyword !== undefined
					? {
							filterKeyword:
								typeof ctx.body.filterKeyword === "string"
									? ctx.body.filterKeyword
									: null,
						}
					: {}),
				...(ctx.body.createTodo !== undefined
					? { createTodo: ctx.body.createTodo === true }
					: {}),
				...(ctx.body.createReminder !== undefined
					? { createReminder: ctx.body.createReminder === true }
					: {}),
				...(ctx.body.enabled !== undefined
					? { enabled: ctx.body.enabled === true }
					: {}),
			});

			const fresh = ok ? getEndpointById(ctx.user!.discordId, id) : undefined;
			sendJson(ctx.res, 200, {
				success: ok,
				...(fresh
					? {
							endpoint: {
								...toEndpointView(fresh),
								url: buildHookUrl(fresh.token),
							},
						}
					: {}),
				message: ok
					? "Webhookエンドポイントを更新しました。"
					: "エンドポイントが見つかりません。",
			});
		},
	},

	// ── 削除 ──
	{
		method: "POST",
		path: "/api/webhooks/delete",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			const ok = deleteEndpoint(ctx.user!.discordId, id);
			sendJson(ctx.res, 200, {
				success: ok,
				message: ok
					? "Webhookエンドポイントを削除しました。"
					: "エンドポイントが見つかりません。",
			});
		},
	},

	// ── 受信履歴（監査 §3.13.4） ──
	{
		method: "GET",
		path: "/api/webhooks/deliveries",
		auth: "user",
		async handler(ctx) {
			const endpointIdParam = ctx.url.searchParams.get("endpointId");
			const endpointId = endpointIdParam ? Number(endpointIdParam) : undefined;
			const deliveries = listDeliveries(
				ctx.user!.discordId,
				Number.isInteger(endpointId) ? endpointId : undefined,
				50,
			);
			sendJson(ctx.res, 200, { success: true, deliveries });
		},
	},
];
