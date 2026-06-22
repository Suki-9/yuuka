import type { RouteDef, RouteRequestCtx } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
	createPersona,
	updatePersona,
	deletePersona,
	getPersonaById,
	listPersonasForUser,
	listPublicPersonas,
	importPersona,
	adminUnpublishPersona,
	adminDeletePersona,
	getActivePersonaIdForBot,
	setActivePersonaForBot,
	PERSONA_MAX_LENGTH,
} from "../../db/personaRepo.js";
import {
	getBotById,
	setRecommendedPersona,
	hasBotAccess,
} from "../../db/botRepo.js";
import { addAuditLog } from "../../db/auditRepo.js";

// ─── ペルソナ管理・マーケットプレイス HTTPルート（§4.1, §5.2） ────────────────

// 適用中ペルソナは (user_id, bot_id) スコープ（v8）。リクエストの botId を解決し、
// 当該ユーザーがアクセスできない botId は system_default にフォールバックする
// （他ユーザーのBotスコープへの書き込み・参照を避ける）。
function resolveScopedBotId(ctx: RouteRequestCtx, userId: string): string {
	const raw =
		(typeof ctx.body?.botId === "string" && ctx.body.botId) ||
		ctx.url.searchParams.get("botId") ||
		"";
	return raw && hasBotAccess(userId, raw) ? raw : "system_default";
}

export const personaRoutes: RouteDef[] = [
	// ── 自分のペルソナ一覧 + 適用中ID（選択中Botスコープ） ──
	{
		method: "GET",
		path: "/api/personas",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveScopedBotId(ctx, userId);
			sendJson(ctx.res, 200, {
				success: true,
				personas: listPersonasForUser(userId),
				active_persona_id: getActivePersonaIdForBot(userId, botId),
				max_length: PERSONA_MAX_LENGTH,
			});
		},
	},

	// ── 新規作成 / 更新（id 指定時は更新） ──
	{
		method: "POST",
		path: "/api/personas/save",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const name =
				typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
			const prompt = typeof ctx.body.prompt === "string" ? ctx.body.prompt : "";
			const id = ctx.body.id != null ? Number(ctx.body.id) : null;

			// バリデーションはハンドラ内で明示的に行いユーザー向けメッセージを返す。
			// 想定外（DB/IO）の例外はサーバーログに留め、内部詳細をクライアントへ漏らさない。
			if (!name) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "ペルソナ名は必須です。",
				});
			}
			if (prompt.length > PERSONA_MAX_LENGTH) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: `ペルソナは${PERSONA_MAX_LENGTH.toLocaleString()}文字以内です（現在: ${prompt.length.toLocaleString()}文字）`,
				});
			}
			try {
				if (id != null && Number.isInteger(id)) {
					const ok = updatePersona(userId, id, { name, prompt });
					if (!ok) {
						return sendJson(ctx.res, 404, {
							success: false,
							message: "ペルソナが見つからないか、所有者ではありません。",
						});
					}
					sendJson(ctx.res, 200, {
						success: true,
						message: `ペルソナ「${name}」を更新しました。`,
					});
				} else {
					const persona = createPersona(userId, name, prompt);
					sendJson(ctx.res, 200, {
						success: true,
						persona,
						message: `ペルソナ「${name}」を作成しました。`,
					});
				}
			} catch (err) {
				console.error("[persona/save] 保存エラー:", err);
				sendJson(ctx.res, 500, {
					success: false,
					message: "ペルソナの保存に失敗しました。",
				});
			}
		},
	},

	// ── 削除 ──
	{
		method: "POST",
		path: "/api/personas/delete",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			const ok = deletePersona(ctx.user!.discordId, id);
			sendJson(ctx.res, 200, {
				success: ok,
				message: ok
					? "ペルソナを削除しました。"
					: "ペルソナが見つからないか、所有者ではありません。",
			});
		},
	},

	// ── 適用（選択中Botの適用ペルソナを更新。v8: (user_id, bot_id) スコープ） ──
	{
		method: "POST",
		path: "/api/personas/activate",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = resolveScopedBotId(ctx, userId);
			const id =
				ctx.body.id != null && ctx.body.id !== "" ? Number(ctx.body.id) : null;

			if (id != null) {
				if (!Number.isInteger(id)) {
					return sendJson(ctx.res, 400, {
						success: false,
						message: "id が不正です。",
					});
				}
				const persona = getPersonaById(id);
				if (!persona || persona.owner_id !== userId) {
					return sendJson(ctx.res, 403, {
						success: false,
						message: "自分のペルソナのみ適用できます。",
					});
				}
				setActivePersonaForBot(userId, botId, id);
				sendJson(ctx.res, 200, {
					success: true,
					message: `ペルソナ「${persona.name}」を適用しました。`,
				});
			} else {
				// null = デフォルトペルソナへ戻す（このBotの適用を解除）
				setActivePersonaForBot(userId, botId, null);
				sendJson(ctx.res, 200, {
					success: true,
					message: "デフォルトペルソナに戻しました。",
				});
			}
		},
	},

	// ── 公開/非公開の切り替え（§4.1.3） ──
	{
		method: "POST",
		path: "/api/personas/publish",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			const isPublic = ctx.body.isPublic === true;
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			const ok = updatePersona(ctx.user!.discordId, id, { isPublic });
			sendJson(ctx.res, 200, {
				success: ok,
				message: ok
					? isPublic
						? "ペルソナをマーケットプレイスに公開しました。"
						: "ペルソナを非公開にしました。"
					: "ペルソナが見つからないか、所有者ではありません。",
			});
		},
	},

	// ── マーケットプレイス一覧（§4.1.3） ──
	{
		method: "GET",
		path: "/api/personas/marketplace",
		auth: "user",
		async handler(ctx) {
			sendJson(ctx.res, 200, { success: true, personas: listPublicPersonas() });
		},
	},

	// ── 公開ペルソナの全文プレビュー（インポート判断用） ──
	{
		method: "GET",
		path: "/api/personas/marketplace/:id",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.params.id);
			const persona = Number.isInteger(id) ? getPersonaById(id) : undefined;
			if (!persona || persona.is_public !== 1) {
				return sendJson(ctx.res, 404, {
					success: false,
					message: "公開ペルソナが見つかりません。",
				});
			}
			sendJson(ctx.res, 200, {
				success: true,
				persona: { id: persona.id, name: persona.name, prompt: persona.prompt },
			});
		},
	},

	// ── インポート（独立コピー §4.1.3） ──
	{
		method: "POST",
		path: "/api/personas/import",
		auth: "user",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			const copied = importPersona(ctx.user!.discordId, id);
			if (!copied) {
				return sendJson(ctx.res, 404, {
					success: false,
					message:
						"公開ペルソナが見つかりません（非公開化された可能性があります）。",
				});
			}
			sendJson(ctx.res, 200, {
				success: true,
				persona: copied,
				message: `ペルソナ「${copied.name}」をインポートしました。「適用」すると会話に反映されます。`,
			});
		},
	},

	// ── Botの推奨ペルソナ設定（Bot作成者のみ・is_public のみ可 §5.2.1） ──
	{
		method: "POST",
		path: "/api/bots/recommended-persona",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const botId = typeof ctx.body.botId === "string" ? ctx.body.botId : "";
			const personaId =
				ctx.body.personaId != null && ctx.body.personaId !== ""
					? Number(ctx.body.personaId)
					: null;

			const bot = getBotById(botId);
			if (!bot || bot.user_id !== userId) {
				return sendJson(ctx.res, 403, {
					success: false,
					message: "Botの作成者のみが推奨ペルソナを設定できます。",
				});
			}

			if (personaId != null) {
				if (!Number.isInteger(personaId)) {
					return sendJson(ctx.res, 400, {
						success: false,
						message: "personaId が不正です。",
					});
				}
				const persona = getPersonaById(personaId);
				if (!persona || persona.is_public !== 1) {
					return sendJson(ctx.res, 400, {
						success: false,
						message:
							"公開（is_public）ペルソナのみ推奨ペルソナに設定できます。",
					});
				}
				setRecommendedPersona(botId, personaId);
				sendJson(ctx.res, 200, {
					success: true,
					message: `推奨ペルソナを「${persona.name}」に設定しました。`,
				});
			} else {
				setRecommendedPersona(botId, null);
				sendJson(ctx.res, 200, {
					success: true,
					message: "推奨ペルソナを解除しました。",
				});
			}
		},
	},

	// ── Admin: マーケットプレイス管理（非公開化・削除 §5.3.2） ──
	{
		method: "POST",
		path: "/api/admin/personas/unpublish",
		auth: "admin",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			const ok = adminUnpublishPersona(id);
			if (ok) {
				addAuditLog(
					ctx.user!.discordId,
					"admin.persona_unpublish",
					`persona:${id}`,
				);
			}
			sendJson(ctx.res, 200, {
				success: ok,
				message: ok
					? "ペルソナを非公開化しました。"
					: "ペルソナが見つかりません。",
			});
		},
	},
	{
		method: "POST",
		path: "/api/admin/personas/delete",
		auth: "admin",
		async handler(ctx) {
			const id = Number(ctx.body.id);
			if (!Number.isInteger(id)) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			}
			const ok = adminDeletePersona(id);
			if (ok) {
				addAuditLog(
					ctx.user!.discordId,
					"admin.persona_delete",
					`persona:${id}`,
				);
			}
			sendJson(ctx.res, 200, {
				success: ok,
				message: ok ? "ペルソナを削除しました。" : "ペルソナが見つかりません。",
			});
		},
	},
];
