import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
	addExpense,
	listRecentExpenses,
	getMonthlyTotal,
	getMonthlyIncomeTotal,
	getMonthlyCategoryBreakdown,
	getMonthlyTrend,
	getBudgetLimits,
	upsertBudgetLimit,
	deleteBudgetLimit,
} from "../../db/expenseRepo.js";
import {
	addPlannedPayment,
	listPlannedPayments,
	getPlannedPaymentById,
	settlePlannedPayment,
	cancelPlannedPayment,
} from "../../db/plannedPaymentRepo.js";
import { completeTodoByPaymentLink } from "../../db/todoRepo.js";
import { hasBotAccess } from "../../db/botRepo.js";
import { parseReceipt } from "../../services/receiptParser.js";
import {
	consumeRateLimit,
	rateLimitMessage,
} from "../../services/botRateLimit.js";

// ─── 家計簿・予算・支払い予定 HTTPルート（§3.4） ─────────────────────────────

// レシート画像のMIME許可リスト（LLMに渡せる画像形式に限定）
const ALLOWED_RECEIPT_MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/heic",
	"image/heif",
	"image/gif",
]);

export const financeRoutes: RouteDef[] = [
	// ── 収支一覧・集計 ──
	{
		method: "GET",
		path: "/api/expenses",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const now = new Date();
			const year = parseInt(
				ctx.url.searchParams.get("year") || String(now.getFullYear()),
				10,
			);
			const month = parseInt(
				ctx.url.searchParams.get("month") || String(now.getMonth() + 1),
				10,
			);

			sendJson(ctx.res, 200, {
				success: true,
				expenses: listRecentExpenses(userId, botId, 30),
				total: getMonthlyTotal(userId, botId, year, month),
				incomeTotal: getMonthlyIncomeTotal(userId, botId, year, month),
				breakdown: getMonthlyCategoryBreakdown(userId, botId, year, month),
				trend: getMonthlyTrend(userId, botId, 6),
			});
		},
	},
	{
		method: "POST",
		path: "/api/expenses/add",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const { amount, category, description, date, time, type } =
				ctx.body as Record<string, unknown>;
			if (!amount || !category || typeof category !== "string") {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "金額とカテゴリは必須です。",
				});
			}
			const expense = addExpense(
				userId,
				botId,
				Number(amount),
				category,
				typeof description === "string" ? description : undefined,
				typeof date === "string" ? date : undefined,
				typeof time === "string" ? time : undefined,
				"manual",
				type === "income" ? "income" : "expense",
			);
			sendJson(ctx.res, 200, { success: true, expense });
		},
	},

	// ── レシート解析（§3.4.2） ──
	{
		method: "POST",
		path: "/api/expenses/upload-receipt",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const { botId, imageBase64, mimeType, additionalText } =
				ctx.body as Record<string, string>;
			if (!imageBase64 || !mimeType) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "画像データ(base64)とMIMEタイプが必要です。",
				});
			}
			// MIME検証: 画像以外をLLMへ渡さない
			if (
				!ALLOWED_RECEIPT_MIME.has(mimeType.toLowerCase().split(";")[0].trim())
			) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "対応していない画像形式です（png/jpeg/webp/heic/gif）。",
				});
			}

			const resolvedBotId =
				botId && hasBotAccess(userId, botId) ? botId : "system_default";

			// コスト増幅DoS対策: LLM呼び出し前にユーザー単位のレート制限を消費する
			const rl = await consumeRateLimit(resolvedBotId, "web", userId);
			if (!rl.allowed) {
				return sendJson(ctx.res, 429, {
					success: false,
					message: rateLimitMessage(rl.exceeded!),
				});
			}

			console.log(
				`📸 [User: ${userId}] WEB管理画面より画像解析要求を受信 (MIME: ${mimeType})`,
			);
			const response = await parseReceipt(
				resolvedBotId,
				userId,
				imageBase64,
				mimeType,
				additionalText || undefined,
			);
			sendJson(ctx.res, 200, { success: true, response });
		},
	},

	// ── 予算上限 ──
	{
		method: "GET",
		path: "/api/expenses/budget-limits",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			sendJson(ctx.res, 200, {
				success: true,
				limits: getBudgetLimits(userId, botId),
			});
		},
	},
	{
		method: "POST",
		path: "/api/expenses/budget-limits",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const { category, limitAmount } = ctx.body as Record<string, unknown>;
			if (
				!category ||
				typeof category !== "string" ||
				limitAmount === undefined
			) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "category と limitAmount は必須です。",
				});
			}
			if (typeof limitAmount !== "number" || limitAmount < 0) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "limitAmount は0以上の数値で指定してください。",
				});
			}
			upsertBudgetLimit(userId, botId, category, limitAmount);
			sendJson(ctx.res, 200, {
				success: true,
				message: `${category} の予算上限を ¥${limitAmount.toLocaleString()} に設定しました。`,
			});
		},
	},
	{
		method: "POST",
		path: "/api/expenses/budget-limits/delete",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const { category } = ctx.body as Record<string, string>;
			if (!category)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "category は必須です。",
				});
			deleteBudgetLimit(userId, botId, category);
			sendJson(ctx.res, 200, {
				success: true,
				message: `${category} の予算上限を削除しました。`,
			});
		},
	},

	// ── 支払い予定・消込（§3.4.3） ──
	{
		method: "GET",
		path: "/api/expenses/plans",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const includePaid = ctx.url.searchParams.get("includePaid") === "true";
			const plans = listPlannedPayments(
				userId,
				botId,
				includePaid ? {} : { status: "pending" },
			);
			sendJson(ctx.res, 200, { success: true, plans });
		},
	},
	{
		method: "POST",
		path: "/api/expenses/plans/add",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const {
				title,
				amount,
				category,
				plannedDate,
				dueDate,
				description,
				repeatRule,
			} = ctx.body as Record<string, unknown>;
			const due =
				(typeof dueDate === "string" && dueDate) ||
				(typeof plannedDate === "string" && plannedDate); // 旧UI互換: plannedDate
			if (
				!title ||
				typeof title !== "string" ||
				!amount ||
				!category ||
				typeof category !== "string" ||
				!due
			) {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "title、amount、category、期日 は必須です。",
				});
			}
			const plan = addPlannedPayment(userId, botId, {
				title,
				amount: Number(amount),
				category,
				dueDate: due,
				memo: typeof description === "string" ? description : undefined,
				repeatRule:
					typeof repeatRule === "string" && repeatRule ? repeatRule : undefined,
			});
			sendJson(ctx.res, 200, { success: true, plan });
		},
	},
	{
		method: "POST",
		path: "/api/expenses/plans/pay",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const id = Number(ctx.body.id);
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});

			const plan = getPlannedPaymentById(userId, botId, id);
			if (!plan)
				return sendJson(ctx.res, 404, {
					success: false,
					message: "支払い予定が見つかりません。",
				});
			if (plan.status !== "pending") {
				return sendJson(ctx.res, 400, {
					success: false,
					message: "既に消込済みまたはキャンセル済みです。",
				});
			}

			// 実支払いを Expense として記録し、消込（§3.4.3）
			const expense = addExpense(
				userId,
				botId,
				plan.amount,
				plan.category,
				plan.title,
				undefined,
				undefined,
				"manual",
				"expense",
			);
			settlePlannedPayment(userId, botId, id, expense.id);

			// 紐付きToDoの自動完了（§3.4.3 手順4）
			const completedTodos = completeTodoByPaymentLink(userId, botId, id);

			sendJson(ctx.res, 200, {
				success: true,
				expense,
				completedTodos: completedTodos.length,
				message: `「${plan.title}」の支払いを消込しました。${completedTodos.length > 0 ? `（紐付くToDo ${completedTodos.length}件を自動完了）` : ""}`,
			});
		},
	},
	{
		method: "POST",
		path: "/api/expenses/plans/delete",
		auth: "user",
		async handler(ctx) {
			const userId = ctx.user!.discordId;
			const rawBotId =
				(ctx.body.botId as string | undefined) ??
				ctx.url.searchParams.get("botId") ??
				undefined;
			const botId =
				rawBotId && hasBotAccess(userId, rawBotId)
					? rawBotId
					: "system_default";
			const id = Number(ctx.body.id);
			if (!id)
				return sendJson(ctx.res, 400, {
					success: false,
					message: "id は必須です。",
				});
			const ok = cancelPlannedPayment(userId, botId, id);
			sendJson(ctx.res, 200, { success: ok });
		},
	},
];
