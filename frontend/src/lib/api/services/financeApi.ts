// financeApi — bot-scoped（scope:'bot'）。src/server/routes/financeRoutes.ts に対応。
import { api } from "../client";
import type {
	ExpensesResponse,
	BudgetLimitsResponse,
	PlannedPaymentsResponse,
	ApiResponse,
} from "../types";

const BOT = { scope: "bot" } as const;

export const financeApi = {
	/** GET /api/expenses — 収支一覧（月フィルタ等は query） */
	list: (query?: { month?: string; type?: string }) =>
		api.get<ExpensesResponse>("/api/expenses", { ...BOT, query }),

	/** POST /api/expenses/add */
	add: (body: {
		type: "income" | "expense";
		amount: number;
		category: string;
		memo?: string;
		date?: string;
		time?: string;
	}) => api.post<ApiResponse>("/api/expenses/add", body, BOT),

	/**
	 * POST /api/expenses/upload-receipt — レシートOCR（multipart）。
	 * FormData を渡すと botId は query へ回る。
	 */
	uploadReceipt: (form: FormData) =>
		api.post<ApiResponse>("/api/expenses/upload-receipt", form, BOT),

	// ── 予算上限 ──
	/** GET /api/expenses/budget-limits */
	budgetLimits: () => api.get<BudgetLimitsResponse>("/api/expenses/budget-limits", BOT),
	/** POST /api/expenses/budget-limits */
	saveBudgetLimit: (body: { category: string; monthly_limit: number }) =>
		api.post<ApiResponse>("/api/expenses/budget-limits", body, BOT),
	/** POST /api/expenses/budget-limits/delete */
	deleteBudgetLimit: (category: string) =>
		api.post<ApiResponse>("/api/expenses/budget-limits/delete", { category }, BOT),

	// ── 予定支払（plannedPayment） ──
	/** GET /api/expenses/plans */
	plans: () => api.get<PlannedPaymentsResponse>("/api/expenses/plans", BOT),
	/** POST /api/expenses/plans/add */
	addPlan: (body: {
		title: string;
		amount: number;
		due_date: string;
		category?: string;
	}) => api.post<ApiResponse>("/api/expenses/plans/add", body, BOT),
	/** POST /api/expenses/plans/pay */
	payPlan: (id: number) => api.post<ApiResponse>("/api/expenses/plans/pay", { id }, BOT),
	/** POST /api/expenses/plans/delete */
	deletePlan: (id: number) =>
		api.post<ApiResponse>("/api/expenses/plans/delete", { id }, BOT),
};
