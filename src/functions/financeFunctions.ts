import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { CronExpressionParser } from "cron-parser";
import * as expenseRepo from "../db/expenseRepo.js";
import {
	CATEGORIES,
	type ExpenseRecord,
	type ExpenseType,
} from "../db/expenseRepo.js";
import type {
	PlannedPaymentRecord,
	PlannedPaymentStatus,
} from "../db/plannedPaymentRepo.js";
import * as plannedPaymentRepo from "../db/plannedPaymentRepo.js";
import * as reminderRepo from "../db/reminderRepo.js";
import * as todoRepo from "../db/todoRepo.js";
import { calcNextRecurringDueDate } from "../services/paymentRecurrenceService.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
	currentMonthLabel,
	formatCurrency,
	formatDate,
} from "../utils/formatters.js";

// ─── 家計管理・支払い予定・消込 Function 群（§3.4） ──────────────────────────
//
// 旧 expenseFunctions.ts の置き換え。全データは ctx.userId（DiscordユーザーID）でスコープする。
// - 収支記録は type（income/expense）に対応し、支出記録時は予算消化率と
//   消込候補（§3.4.2 手順6, §3.4.3 消込フロー手順2: 自動照合）を併せて返す。
// - 支払い予定はToDo・リマインド連携（linkPlannedPaymentTodo / linkPlannedPaymentReminder）、
//   消込（settlePlannedPayment）、繰り返し（repeat_rule + paymentRecurrenceService）に対応する。

const CATEGORY_LIST = CATEGORIES.join(", ");

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** Function Call の引数から空でない文字列を取り出す（無ければ undefined） */
export function asOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** Function Call の引数から整数を取り出す（数値でなければ undefined） */
export function asOptionalInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.trunc(value);
}

/** 'YYYY-MM-DD' 形式かどうか */
export function isYmd(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 今日の日付を 'YYYY-MM-DD'（ローカルタイム）で返す */
export function todayYmd(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 収支差の符号付き表示（例: '+¥12,000' / '-¥3,400'） */
export function formatBalance(balance: number): string {
	return `${balance >= 0 ? "+" : "-"}${formatCurrency(Math.abs(balance))}`;
}

/** 収支記録のLLM向け共通整形 */
function toExpenseEntry(expense: ExpenseRecord) {
	return {
		expense_id: expense.id,
		type: expense.type,
		amount: expense.amount,
		category: expense.category,
		memo: expense.memo,
		date: expense.date,
		source: expense.source,
	};
}

/** 収支記録の1行表示（メッセージ用） */
function expenseLine(expense: ExpenseRecord): string {
	const typeLabel = expense.type === "income" ? "📈 収入" : "📉 支出";
	const memo = expense.memo ? ` — ${expense.memo}` : "";
	return `#${expense.id} ${formatDate(expense.date)} | ${typeLabel} | ${expense.category} | ${formatCurrency(expense.amount)}${memo}`;
}

/** 支払い予定のLLM向け共通整形 */
function toPlanEntry(plan: PlannedPaymentRecord) {
	return {
		plan_id: plan.id,
		title: plan.title,
		amount: plan.amount,
		category: plan.category,
		memo: plan.memo,
		due_date: plan.due_date,
		repeat_rule: plan.repeat_rule,
		status: plan.status,
		settled_expense_id: plan.settled_expense_id,
		linked_todo_id: plan.linked_todo_id,
		linked_reminder_id: plan.linked_reminder_id,
	};
}

/** 支払い予定の1行表示（メッセージ用） */
function planLine(plan: PlannedPaymentRecord): string {
	const marks: string[] = [];
	if (plan.repeat_rule) marks.push("🔁");
	if (plan.status === "pending" && plan.due_date < todayYmd())
		marks.push("⚠️期日超過");
	const statusLabel =
		plan.status === "settled"
			? " ✅消込済"
			: plan.status === "cancelled"
				? " ❌キャンセル"
				: "";
	const links: string[] = [];
	if (plan.linked_todo_id) links.push(`ToDo#${plan.linked_todo_id}`);
	if (plan.linked_reminder_id)
		links.push(`リマインド#${plan.linked_reminder_id}`);
	return (
		`#${plan.id} [${plan.due_date}] ${plan.title} — ${plan.category} ${formatCurrency(plan.amount)}` +
		`${marks.length > 0 ? " " + marks.join(" ") : ""}${statusLabel}` +
		`${links.length > 0 ? ` (連携: ${links.join(", ")})` : ""}`
	);
}

// ─── Function Declarations ───────────────────────────────────────────────────

const declarations: FunctionDeclaration[] = [
	// ── 収支記録（§3.4.1） ──
	{
		name: "addExpense",
		description:
			`収入または支出を家計簿に記録します。「〇〇円使った」「ランチ1200円」「給料が振り込まれた」などの報告や、レシートOCRの内容をユーザーが承認した時に呼び出してください。支出のカテゴリは: ${CATEGORY_LIST}。` +
			`記録結果には予算の消化状況と、対応しそうな支払い予定（消込候補）が含まれます。消込候補が見つかった場合は「この支払い予定を消込しますか？」とユーザーに確認し、承認されたら settlePlannedPayment を呼んでください（§3.4.3 消込フロー）。`,
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				amount: {
					type: SchemaType.NUMBER,
					description: "金額（円、1以上の整数）",
				},
				category: {
					type: SchemaType.STRING,
					description: `カテゴリ。支出の場合: ${CATEGORY_LIST} のいずれか。収入の場合は内容に合う名称（例: 給与, 賞与, 副収入）`,
				},
				type: {
					type: SchemaType.STRING,
					description:
						"収支区分: 'expense'（支出、デフォルト）| 'income'（収入）",
				},
				memo: {
					type: SchemaType.STRING,
					description: "メモ（店名・品目・用途など。任意）",
				},
				date: {
					type: SchemaType.STRING,
					description: "日付 (YYYY-MM-DD形式。省略時は今日)",
				},
				time: {
					type: SchemaType.STRING,
					description:
						"時刻 (HH:MM:SS形式。レシートに記載がある場合など。任意)",
				},
				source: {
					type: SchemaType.STRING,
					description:
						"記録元: 'manual'（デフォルト）| 'receipt_ocr'（レシート画像からの自動記帳時のみ指定）",
				},
			},
			required: ["amount", "category"],
		},
	},
	{
		name: "getMonthlySummary",
		description:
			"指定月の収支サマリー（収入合計・支出合計・収支差・支出のカテゴリ別内訳）を取得します。「今月いくら使った？」「先月の収支は？」などの質問で呼び出してください。年月省略時は今月です。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				year: {
					type: SchemaType.NUMBER,
					description: "年（例: 2026。省略時は今年）",
				},
				month: {
					type: SchemaType.NUMBER,
					description: "月（1〜12。省略時は今月）",
				},
			},
		},
	},
	{
		name: "getCategoryBreakdown",
		description:
			"指定月のカテゴリ別内訳（金額・件数・構成比）を取得します。「カテゴリ別に見せて」「何に一番使ってる？」などの質問で呼び出してください。type で支出（デフォルト）と収入を切り替えられます。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				year: { type: SchemaType.NUMBER, description: "年（省略時は今年）" },
				month: {
					type: SchemaType.NUMBER,
					description: "月（1〜12。省略時は今月）",
				},
				type: {
					type: SchemaType.STRING,
					description:
						"集計対象: 'expense'（支出、デフォルト）| 'income'（収入）",
				},
			},
		},
	},
	{
		name: "listRecentExpenses",
		description:
			"直近の収支記録を新しい順に取得します。「最近の支出見せて」「記録一覧」などの依頼で呼び出してください。type で支出のみ・収入のみに絞り込めます。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				count: {
					type: SchemaType.NUMBER,
					description: "取得件数（デフォルト10件）",
				},
				type: {
					type: SchemaType.STRING,
					description:
						"絞り込み: 'expense'（支出のみ）| 'income'（収入のみ）。省略時は両方",
				},
			},
		},
	},

	// ── 予算管理（§3.4.1） ──
	{
		name: "getBudgetLimits",
		description:
			"カテゴリごとの月次予算上限と今月の消化状況（使用額・消化率）を取得します。「予算どれくらい残ってる？」「予算設定を見せて」などの依頼で呼び出してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {},
		},
	},
	{
		name: "setBudgetLimit",
		description: `カテゴリの月次予算上限を設定・更新します。「食費の予算を3万円にして」などの依頼で呼び出してください。カテゴリは: ${CATEGORY_LIST}。`,
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				category: {
					type: SchemaType.STRING,
					description: `予算を設定するカテゴリ（${CATEGORY_LIST} のいずれか）`,
				},
				limit_amount: {
					type: SchemaType.NUMBER,
					description: "月次予算上限（円、1以上の整数）",
				},
			},
			required: ["category", "limit_amount"],
		},
	},
	{
		name: "deleteBudgetLimit",
		description:
			"カテゴリの月次予算上限を削除します。「食費の予算設定を消して」などの依頼で呼び出してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				category: {
					type: SchemaType.STRING,
					description: "予算上限を削除するカテゴリ",
				},
			},
			required: ["category"],
		},
	},

	// ── 支払い予定（§3.4.3） ──
	{
		name: "listPlannedPayments",
		description:
			"支払い予定の一覧を取得します。「今月の支払い予定は？」「未払いある？」などの質問で呼び出してください。デフォルトでは未消込（pending）のみを期日の近い順に返し、期日超過の予定には⚠️が付きます。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				status: {
					type: SchemaType.STRING,
					description:
						"フィルタするステータス: 'pending'（未消込、デフォルト）| 'settled'（消込済み）| 'cancelled'（キャンセル済み）| 'all'（全て）",
				},
			},
		},
	},
	{
		name: "addPlannedPayment",
		description:
			`支払い予定を登録します（§3.4.3）。「27日に家賃8万円の支払いがある」などの自然言語から title/amount/category/due_date を構造化して登録してください。カテゴリは: ${CATEGORY_LIST}。` +
			`家賃・サブスク等の繰り返し支払いは repeat_rule（cron式、例: '0 0 27 * *' = 毎月27日）を指定すると、期日経過後・消込後に次回予定が自動生成されます。` +
			`【重要】登録後は必ず「ToDoとして追加する？」「リマインドを設定する？」をユーザーに確認し、希望されたら linkPlannedPaymentTodo / linkPlannedPaymentReminder を呼ぶこと（§3.4.3）。`,
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				title: {
					type: SchemaType.STRING,
					description: "支払いの概要（例: 家賃, Netflix, 自動車税）",
				},
				amount: {
					type: SchemaType.NUMBER,
					description: "予定金額（円、1以上の整数）",
				},
				category: {
					type: SchemaType.STRING,
					description: `カテゴリ（${CATEGORY_LIST} のいずれか）`,
				},
				due_date: {
					type: SchemaType.STRING,
					description: "支払い期日 (YYYY-MM-DD形式)",
				},
				memo: { type: SchemaType.STRING, description: "メモ（任意）" },
				repeat_rule: {
					type: SchemaType.STRING,
					description:
						"繰り返し支払いの周期（cron式。例: '0 0 27 * *' = 毎月27日、'0 0 1 4 *' = 毎年4月1日）。単発の支払いでは指定しない（任意）",
				},
			},
			required: ["title", "amount", "category", "due_date"],
		},
	},
	{
		name: "settlePlannedPayment",
		description:
			"支払い予定を消込（settled に）します（§3.4.3 消込フロー）。必ずユーザーの承認を得てから呼び出してください。expense_id を指定すると既存の支出記録と紐付けて消込し、省略すると予定の金額・カテゴリで新しい支出を自動記帳して消込します。予定に紐付いたToDoは自動的に完了になり、繰り返し予定（repeat_rule付き）は次回の予定が自動生成されます。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				plan_id: {
					type: SchemaType.NUMBER,
					description: "消込する支払い予定のID（#番号）",
				},
				expense_id: {
					type: SchemaType.NUMBER,
					description:
						"紐付ける既存の支出記録のID（addExpense や findSettlementCandidates の結果から取得）。省略時は予定の内容で支出を新規記帳して消込します（任意）",
				},
			},
			required: ["plan_id"],
		},
	},
	{
		name: "cancelPlannedPayment",
		description:
			"支払い予定をキャンセルします。不要になった・誤登録の場合に呼び出してください（実際に支払った場合はキャンセルではなく settlePlannedPayment を使用）。繰り返し予定をキャンセルすると以後の自動生成も止まります。紐付いた期日前リマインドは自動的にキャンセルされます。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				plan_id: {
					type: SchemaType.NUMBER,
					description: "キャンセルする支払い予定のID（#番号）",
				},
			},
			required: ["plan_id"],
		},
	},
	{
		name: "findSettlementCandidates",
		description:
			"実際の支払い記録（金額・カテゴリ・日付）に対応しそうな未消込の支払い予定（消込候補）を検索します。照合条件は金額±10%・同カテゴリ・期日±7日です（§3.4.3 消込フロー手順2: 自動照合）。レシートOCRや手動記帳の後に消込候補を探す際に呼び出し、候補が見つかったら「この予定を消込しますか？」とユーザーに確認して、承認されたら settlePlannedPayment を呼んでください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				amount: {
					type: SchemaType.NUMBER,
					description: "実際の支払い金額（円、整数）",
				},
				category: {
					type: SchemaType.STRING,
					description: "実際の支払いのカテゴリ",
				},
				date: {
					type: SchemaType.STRING,
					description: "実際の支払い日 (YYYY-MM-DD形式。省略時は今日)",
				},
			},
			required: ["amount", "category"],
		},
	},
	{
		name: "linkPlannedPaymentTodo",
		description:
			"支払い予定からToDoを生成して紐付けます（§3.4.3 ToDo連携）。addPlannedPayment の登録後にユーザーが「ToDoとして追加して」と希望した場合に呼び出してください。ToDoには期日（支払い期日）とタグ（「支払い」+ カテゴリ名）が自動付与され、予定の消込時にToDoも自動的に完了になります。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				plan_id: {
					type: SchemaType.NUMBER,
					description: "ToDoを生成する支払い予定のID（#番号）",
				},
			},
			required: ["plan_id"],
		},
	},
	{
		name: "linkPlannedPaymentReminder",
		description:
			"支払い予定の期日前リマインドを設定して紐付けます（§3.4.3 リマインド連携）。addPlannedPayment の登録後にユーザーが「リマインドして」と希望した場合に呼び出してください。days_before で期日の何日前に通知するか指定できます（デフォルト1日前の朝9時に通知）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				plan_id: {
					type: SchemaType.NUMBER,
					description: "リマインドを設定する支払い予定のID（#番号）",
				},
				days_before: {
					type: SchemaType.NUMBER,
					description:
						"期日の何日前に通知するか（0=期日当日の朝。デフォルト1）",
				},
			},
			required: ["plan_id"],
		},
	},
];

// ─── Handlers ────────────────────────────────────────────────────────────────

const handlers: FunctionModule["handlers"] = {
	// 収支記録（§3.4.1, §3.4.2）。支出時は予算消化率と消込候補（自動照合）を併せて返す
	async addExpense(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const amount = asOptionalInt(args.amount);
		if (amount === undefined || amount <= 0) {
			return JSON.stringify({
				success: false,
				message: "amount は1以上の整数（円）で指定してください。",
			});
		}
		const category = asOptionalString(args.category);
		if (!category) {
			return JSON.stringify({
				success: false,
				message: "category を指定してください。",
			});
		}
		const type: ExpenseType = args.type === "income" ? "income" : "expense";

		const date = asOptionalString(args.date);
		if (date && !isYmd(date)) {
			return JSON.stringify({
				success: false,
				message: "date は YYYY-MM-DD 形式で指定してください。",
			});
		}
		const source = args.source === "receipt_ocr" ? "receipt_ocr" : "manual";

		const expense = expenseRepo.addExpense(
			ctx.userId,
			ctx.botId,
			amount,
			category,
			asOptionalString(args.memo),
			date,
			asOptionalString(args.time),
			source,
			type,
		);

		const typeLabel = type === "income" ? "収入" : "支出";
		let message = `${typeLabel} ${formatCurrency(expense.amount)} (${expense.category}) を記録しました${expense.memo ? ` — ${expense.memo}` : ""} (ID: #${expense.id})`;

		let budgetUsage:
			| { limit_amount: number; spent: number; ratio_percent: number }
			| undefined;
		let candidates: PlannedPaymentRecord[] = [];

		if (type === "expense") {
			// 予算消化率の通知（§3.4.1 予算管理）
			const limit = expenseRepo.getBudgetLimit(
				ctx.userId,
				ctx.botId,
				expense.category,
			);
			if (limit) {
				const [y, m] = expense.date.split("-").map(Number);
				const breakdown = expenseRepo.getMonthlyCategoryBreakdown(
					ctx.userId,
					ctx.botId,
					y,
					m,
					"expense",
				);
				const spent =
					breakdown.find((c) => c.category === expense.category)?.total ?? 0;
				const ratio =
					limit.limit_amount > 0
						? Math.round((spent / limit.limit_amount) * 100)
						: 0;
				budgetUsage = {
					limit_amount: limit.limit_amount,
					spent,
					ratio_percent: ratio,
				};
				message += `\n${expense.category}の${y}年${m}月の予算消化率: ${ratio}% (${formatCurrency(spent)} / ${formatCurrency(limit.limit_amount)})`;
				if (ratio >= 100) message += " ⚠️予算を超過しています！";
				else if (ratio >= 80) message += " ⚠️予算の8割を超えています。";
			}

			// 消込候補の自動照合（§3.4.2 手順6, §3.4.3 消込フロー手順2）
			candidates = plannedPaymentRepo.findSettlementCandidates(
				ctx.userId,
				ctx.botId,
				{
					amount: expense.amount,
					category: expense.category,
					date: expense.date,
				},
			);
			if (candidates.length > 0) {
				message +=
					`\n💡 この支出に対応しそうな支払い予定が${candidates.length}件あります:\n` +
					candidates.map(planLine).join("\n") +
					`\n消込するかユーザーに確認し、承認されたら settlePlannedPayment(plan_id, expense_id=${expense.id}) を呼んでください。`;
			}
		}

		return JSON.stringify({
			success: true,
			message,
			expense: toExpenseEntry(expense),
			budget_usage: budgetUsage,
			settlement_candidates: candidates.map(toPlanEntry),
		});
	},

	// 月次収支サマリー（§3.4.1: 収支一覧・集計。収入・支出・収支差を含む）
	async getMonthlySummary(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const year = asOptionalInt(args.year);
		const month = asOptionalInt(args.month);
		const label = currentMonthLabel(year, month);

		const income = expenseRepo.getMonthlyIncomeTotal(
			ctx.userId,
			ctx.botId,
			year,
			month,
		);
		const expense = expenseRepo.getMonthlyTotal(
			ctx.userId,
			ctx.botId,
			year,
			month,
			"expense",
		);
		const balance = income - expense;
		const breakdown = expenseRepo.getMonthlyCategoryBreakdown(
			ctx.userId,
			ctx.botId,
			year,
			month,
			"expense",
		);

		if (income === 0 && expense === 0) {
			return JSON.stringify({
				success: true,
				message: `${label}の収支記録はありません。`,
				income: 0,
				expense: 0,
				balance: 0,
				breakdown: [],
			});
		}

		const lines = [
			`📈 収入: ${formatCurrency(income)}`,
			`📉 支出: ${formatCurrency(expense)}`,
			`💰 収支差: ${formatBalance(balance)}`,
		];
		if (breakdown.length > 0) {
			lines.push("───────────");
			lines.push("支出の内訳:");
			for (const c of breakdown) {
				lines.push(
					`  ${c.category}: ${formatCurrency(c.total)} (${c.count}件)`,
				);
			}
		}

		return JSON.stringify({
			success: true,
			message: `${label}の収支サマリー:\n${lines.join("\n")}`,
			income,
			expense,
			balance,
			breakdown,
		});
	},

	// カテゴリ別内訳（§3.4.1: 期間・カテゴリ別の収支表示）
	async getCategoryBreakdown(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const year = asOptionalInt(args.year);
		const month = asOptionalInt(args.month);
		const type: ExpenseType = args.type === "income" ? "income" : "expense";
		const typeLabel = type === "income" ? "収入" : "支出";
		const label = currentMonthLabel(year, month);

		const breakdown = expenseRepo.getMonthlyCategoryBreakdown(
			ctx.userId,
			ctx.botId,
			year,
			month,
			type,
		);
		const total = expenseRepo.getMonthlyTotal(
			ctx.userId,
			ctx.botId,
			year,
			month,
			type,
		);

		if (breakdown.length === 0) {
			return JSON.stringify({
				success: true,
				message: `${label}の${typeLabel}記録はありません。`,
				total: 0,
				breakdown: [],
			});
		}

		const lines = breakdown.map((c) => {
			const ratio = total > 0 ? ((c.total / total) * 100).toFixed(1) : "0";
			return `${c.category}: ${formatCurrency(c.total)} (${ratio}%, ${c.count}件)`;
		});

		return JSON.stringify({
			success: true,
			message: `${label}の${typeLabel}カテゴリ別内訳:\n${lines.join("\n")}\n合計: ${formatCurrency(total)}`,
			total,
			breakdown,
		});
	},

	// 直近の収支記録（§3.4.1）
	async listRecentExpenses(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const count = asOptionalInt(args.count) ?? 10;
		const type: ExpenseType | undefined =
			args.type === "income" || args.type === "expense" ? args.type : undefined;

		const expenses = expenseRepo.listRecentExpenses(
			ctx.userId,
			ctx.botId,
			Math.max(1, count),
			type,
		);
		if (expenses.length === 0) {
			return JSON.stringify({
				success: true,
				message: "収支の記録はありません。",
				expenses: [],
			});
		}

		const lines = expenses.map(expenseLine);
		return JSON.stringify({
			success: true,
			message: `直近の収支記録 (${expenses.length}件):\n${lines.join("\n")}`,
			expenses: expenses.map(toExpenseEntry),
		});
	},

	// 予算上限の一覧と今月の消化状況（§3.4.1 予算管理）
	async getBudgetLimits(ctx: ToolContext): Promise<string> {
		const limits = expenseRepo.getBudgetLimits(ctx.userId, ctx.botId);
		if (limits.length === 0) {
			return JSON.stringify({
				success: true,
				message:
					"予算上限が設定されているカテゴリはありません。setBudgetLimit で設定できます。",
				limits: [],
			});
		}

		const breakdown = expenseRepo.getMonthlyCategoryBreakdown(
			ctx.userId,
			ctx.botId,
		); // 当月の支出
		const entries = limits.map((l) => {
			const spent =
				breakdown.find((c) => c.category === l.category)?.total ?? 0;
			const ratio =
				l.limit_amount > 0 ? Math.round((spent / l.limit_amount) * 100) : 0;
			return {
				category: l.category,
				limit_amount: l.limit_amount,
				spent,
				ratio_percent: ratio,
			};
		});

		const lines = entries.map((e) => {
			const warn =
				e.ratio_percent >= 100 ? " ⚠️超過" : e.ratio_percent >= 80 ? " ⚠️" : "";
			return `${e.category}: ${formatCurrency(e.limit_amount)}（今月の消化: ${formatCurrency(e.spent)} / ${e.ratio_percent}%${warn}）`;
		});

		return JSON.stringify({
			success: true,
			message: `設定済み予算上限と今月の消化状況:\n${lines.join("\n")}`,
			limits: entries,
		});
	},

	// 予算上限の設定（§3.4.1 予算管理）
	async setBudgetLimit(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const category = asOptionalString(args.category);
		if (!category || !CATEGORIES.includes(category as expenseRepo.Category)) {
			return JSON.stringify({
				success: false,
				message: `無効なカテゴリです: ${args.category}。有効なカテゴリ: ${CATEGORY_LIST}`,
			});
		}
		const limitAmount = asOptionalInt(args.limit_amount);
		if (limitAmount === undefined || limitAmount <= 0) {
			return JSON.stringify({
				success: false,
				message: "limit_amount は1以上の整数（円）で指定してください。",
			});
		}

		expenseRepo.upsertBudgetLimit(ctx.userId, ctx.botId, category, limitAmount);
		return JSON.stringify({
			success: true,
			message: `${category} の月次予算上限を ${formatCurrency(limitAmount)} に設定しました。`,
		});
	},

	// 予算上限の削除
	async deleteBudgetLimit(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const category = asOptionalString(args.category);
		if (!category) {
			return JSON.stringify({
				success: false,
				message: "category を指定してください。",
			});
		}
		const deleted = expenseRepo.deleteBudgetLimit(
			ctx.userId,
			ctx.botId,
			category,
		);
		if (!deleted) {
			return JSON.stringify({
				success: false,
				message: `${category} には予算上限が設定されていません。`,
			});
		}
		return JSON.stringify({
			success: true,
			message: `${category} の予算上限を削除しました。`,
		});
	},

	// 支払い予定の一覧（§3.4.3）
	async listPlannedPayments(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const statusArg = asOptionalString(args.status);
		const status: PlannedPaymentStatus | "all" =
			statusArg === "settled" ||
			statusArg === "cancelled" ||
			statusArg === "all"
				? statusArg
				: "pending";

		const plans = plannedPaymentRepo.listPlannedPayments(
			ctx.userId,
			ctx.botId,
			{ status },
		);
		if (plans.length === 0) {
			return JSON.stringify({
				success: true,
				message:
					status === "pending"
						? "未消込の支払い予定はありません。"
						: "該当する支払い予定はありません。",
				plans: [],
			});
		}

		const lines = plans.map(planLine);
		return JSON.stringify({
			success: true,
			message: `支払い予定 (${plans.length}件):\n${lines.join("\n")}`,
			plans: plans.map(toPlanEntry),
		});
	},

	// 支払い予定の登録（§3.4.3）。登録後はToDo/リマインド連携の確認をLLMに促す
	async addPlannedPayment(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const title = asOptionalString(args.title);
		if (!title) {
			return JSON.stringify({
				success: false,
				message: "title（支払いの概要）を指定してください。",
			});
		}
		const amount = asOptionalInt(args.amount);
		if (amount === undefined || amount <= 0) {
			return JSON.stringify({
				success: false,
				message: "amount は1以上の整数（円）で指定してください。",
			});
		}
		const category = asOptionalString(args.category);
		if (!category || !CATEGORIES.includes(category as expenseRepo.Category)) {
			return JSON.stringify({
				success: false,
				message: `無効なカテゴリです: ${args.category}。有効なカテゴリ: ${CATEGORY_LIST}`,
			});
		}
		const dueDate = asOptionalString(args.due_date);
		if (!dueDate || !isYmd(dueDate)) {
			return JSON.stringify({
				success: false,
				message: "due_date は YYYY-MM-DD 形式で指定してください。",
			});
		}
		const repeatRule = asOptionalString(args.repeat_rule);
		if (repeatRule) {
			try {
				CronExpressionParser.parse(repeatRule);
			} catch {
				return JSON.stringify({
					success: false,
					message: `repeat_rule のcron式が不正です: ${repeatRule}（例: '0 0 27 * *' = 毎月27日）`,
				});
			}
		}

		const plan = plannedPaymentRepo.addPlannedPayment(ctx.userId, ctx.botId, {
			title,
			amount,
			category,
			dueDate,
			memo: asOptionalString(args.memo),
			repeatRule,
		});

		return JSON.stringify({
			success: true,
			message:
				`支払い予定「${plan.title}」(${formatCurrency(plan.amount)}, ${plan.category}, 期日: ${formatDate(plan.due_date)}` +
				`${plan.repeat_rule ? `, 繰り返し: ${plan.repeat_rule}` : ""}) を登録しました (ID: #${plan.id})。\n` +
				`続けてユーザーに「ToDoとして追加しますか？」「期日前リマインドを設定しますか？」と確認し、希望されたら linkPlannedPaymentTodo / linkPlannedPaymentReminder を呼んでください（§3.4.3）。`,
			plan: toPlanEntry(plan),
		});
	},

	// 支払い予定の消込（§3.4.3 消込フロー手順3〜4）
	async settlePlannedPayment(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const planId = asOptionalInt(args.plan_id);
		if (planId === undefined) {
			return JSON.stringify({
				success: false,
				message: "plan_id を指定してください。",
			});
		}
		const plan = plannedPaymentRepo.getPlannedPaymentById(
			ctx.userId,
			ctx.botId,
			planId,
		);
		if (!plan) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} が見つかりません。`,
			});
		}
		if (plan.status !== "pending") {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} は既に${plan.status === "settled" ? "消込済み" : "キャンセル済み"}です。`,
			});
		}

		// 消込対象の Expense を解決（expense_id 省略時は予定の内容で新規記帳）
		const expenseId = asOptionalInt(args.expense_id);
		let expense: ExpenseRecord;
		let createdExpense = false;
		if (expenseId !== undefined) {
			const found = expenseRepo.getExpenseById(
				ctx.userId,
				ctx.botId,
				expenseId,
			);
			if (!found) {
				return JSON.stringify({
					success: false,
					message: `支出記録 #${expenseId} が見つかりません。`,
				});
			}
			if (found.type !== "expense") {
				return JSON.stringify({
					success: false,
					message: `記録 #${expenseId} は収入のため消込に使えません。`,
				});
			}
			expense = found;
		} else {
			expense = expenseRepo.addExpense(
				ctx.userId,
				ctx.botId,
				plan.amount,
				plan.category,
				plan.title,
				todayYmd(),
				undefined,
				"manual",
				"expense",
			);
			createdExpense = true;
		}

		const settled = plannedPaymentRepo.settlePlannedPayment(
			ctx.userId,
			ctx.botId,
			plan.id,
			expense.id,
		);
		if (!settled) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} の消込に失敗しました。`,
			});
		}

		const notes: string[] = [];

		// 紐付きToDoの自動完了（§3.4.3 消込フロー手順4）
		const completedTodos = todoRepo.completeTodoByPaymentLink(
			ctx.userId,
			ctx.botId,
			plan.id,
		);
		if (completedTodos.length > 0) {
			notes.push(
				`紐付きToDo ${completedTodos.map((t) => `「${t.title}」(#${t.id})`).join("、")} を自動的に完了にしました✅`,
			);
		}

		// 支払い済みになったため、不要になった期日前リマインドをキャンセル
		if (plan.linked_reminder_id) {
			const cancelled = reminderRepo.cancelReminder(
				ctx.userId,
				ctx.botId,
				plan.linked_reminder_id,
			);
			if (cancelled)
				notes.push(
					`期日前リマインド (#${plan.linked_reminder_id}) をキャンセルしました。`,
				);
		}

		// 繰り返し予定は次回期日の予定を自動生成（§3.4.3: 自動次回生成）
		let nextPlan: PlannedPaymentRecord | undefined;
		if (plan.repeat_rule) {
			const nextDue = calcNextRecurringDueDate(plan.repeat_rule, plan.due_date);
			if (nextDue) {
				nextPlan = plannedPaymentRepo.advanceRecurring(plan.id, nextDue);
				if (nextPlan) {
					notes.push(
						`🔁 次回の支払い予定 #${nextPlan.id}（期日: ${formatDate(nextDue)}）を自動生成しました。`,
					);
				}
			} else {
				notes.push(
					`⚠️ repeat_rule の解釈に失敗したため次回予定は生成されませんでした (rule: ${plan.repeat_rule})。`,
				);
			}
		}

		const expenseNote = createdExpense
			? `支出 ${formatCurrency(expense.amount)} を新規記帳しました (ID: #${expense.id})。`
			: `支出記録 #${expense.id} と紐付けました。`;

		return JSON.stringify({
			success: true,
			message:
				`支払い予定「${plan.title}」(${formatCurrency(plan.amount)}) を消込しました✅ ${expenseNote}` +
				(notes.length > 0 ? `\n${notes.join("\n")}` : ""),
			plan: toPlanEntry(settled),
			expense: toExpenseEntry(expense),
			completed_todo_ids: completedTodos.map((t) => t.id),
			next_plan: nextPlan ? toPlanEntry(nextPlan) : null,
		});
	},

	// 支払い予定のキャンセル
	async cancelPlannedPayment(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const planId = asOptionalInt(args.plan_id);
		if (planId === undefined) {
			return JSON.stringify({
				success: false,
				message: "plan_id を指定してください。",
			});
		}
		const plan = plannedPaymentRepo.getPlannedPaymentById(
			ctx.userId,
			ctx.botId,
			planId,
		);
		if (!plan) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} が見つかりません。`,
			});
		}
		if (plan.status !== "pending") {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} は既に${plan.status === "settled" ? "消込済み" : "キャンセル済み"}です。`,
			});
		}

		const cancelled = plannedPaymentRepo.cancelPlannedPayment(
			ctx.userId,
			ctx.botId,
			planId,
		);
		if (!cancelled) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} のキャンセルに失敗しました。`,
			});
		}

		const notes: string[] = [];
		// 不要になった期日前リマインドをキャンセル
		if (plan.linked_reminder_id) {
			const r = reminderRepo.cancelReminder(
				ctx.userId,
				ctx.botId,
				plan.linked_reminder_id,
			);
			if (r)
				notes.push(
					`期日前リマインド (#${plan.linked_reminder_id}) もキャンセルしました。`,
				);
		}
		// 紐付きToDoは自動削除しない（ユーザーの判断に委ねる）
		if (plan.linked_todo_id) {
			notes.push(
				`紐付きToDo (#${plan.linked_todo_id}) は残っています。不要なら削除するかユーザーに確認してください。`,
			);
		}
		if (plan.repeat_rule) {
			notes.push("繰り返し予定のため、以後の自動生成も停止します。");
		}

		return JSON.stringify({
			success: true,
			message:
				`支払い予定「${plan.title}」(#${plan.id}) をキャンセルしました🗑️` +
				(notes.length > 0 ? `\n${notes.join("\n")}` : ""),
			plan: toPlanEntry(cancelled),
		});
	},

	// 消込候補の検索（§3.4.3 消込フロー手順2: 自動照合）
	async findSettlementCandidates(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const amount = asOptionalInt(args.amount);
		if (amount === undefined || amount <= 0) {
			return JSON.stringify({
				success: false,
				message: "amount は1以上の整数（円）で指定してください。",
			});
		}
		const category = asOptionalString(args.category);
		if (!category) {
			return JSON.stringify({
				success: false,
				message: "category を指定してください。",
			});
		}
		const dateArg = asOptionalString(args.date);
		if (dateArg && !isYmd(dateArg)) {
			return JSON.stringify({
				success: false,
				message: "date は YYYY-MM-DD 形式で指定してください。",
			});
		}
		const date = dateArg ?? todayYmd();

		const candidates = plannedPaymentRepo.findSettlementCandidates(
			ctx.userId,
			ctx.botId,
			{
				amount,
				category,
				date,
			},
		);
		if (candidates.length === 0) {
			return JSON.stringify({
				success: true,
				message: `条件（${formatCurrency(amount)}±10%・${category}・${formatDate(date)}±7日）に合う未消込の支払い予定はありません。`,
				candidates: [],
			});
		}

		return JSON.stringify({
			success: true,
			message:
				`消込候補が${candidates.length}件見つかりました:\n${candidates.map(planLine).join("\n")}\n` +
				`消込するかユーザーに確認し、承認されたら settlePlannedPayment を呼んでください。`,
			candidates: candidates.map(toPlanEntry),
		});
	},

	// 支払い予定 → ToDo生成・紐付け（§3.4.3 ToDo連携）
	async linkPlannedPaymentTodo(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const planId = asOptionalInt(args.plan_id);
		if (planId === undefined) {
			return JSON.stringify({
				success: false,
				message: "plan_id を指定してください。",
			});
		}
		const plan = plannedPaymentRepo.getPlannedPaymentById(
			ctx.userId,
			ctx.botId,
			planId,
		);
		if (!plan) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} が見つかりません。`,
			});
		}
		if (plan.status !== "pending") {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} は${plan.status === "settled" ? "消込済み" : "キャンセル済み"}のためToDoを生成できません。`,
			});
		}
		if (plan.linked_todo_id) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} には既にToDo (#${plan.linked_todo_id}) が紐付いています。`,
			});
		}

		// タグはLLM自動付与ではなく仕様の固定規則 ["支払い", カテゴリ名] を適用（§3.4.3）
		const todo = todoRepo.addTodo(ctx.userId, ctx.botId, {
			title: `${plan.title}の支払い`,
			description:
				`支払い予定 #${plan.id}: ${formatCurrency(plan.amount)}（期日: ${formatDate(plan.due_date)}）` +
				(plan.memo ? `\n${plan.memo}` : ""),
			dueDate: plan.due_date,
			tags: ["支払い", plan.category],
		});

		// 双方向に紐付ける（消込時の自動完了は todos.linked_payment_id を参照する）
		todoRepo.linkPayment(ctx.userId, ctx.botId, todo.id, plan.id);
		plannedPaymentRepo.linkTodo(ctx.userId, ctx.botId, plan.id, todo.id);

		return JSON.stringify({
			success: true,
			message:
				`支払い予定「${plan.title}」からToDo「${todo.title}」(#${todo.id}, 期限: ${formatDate(plan.due_date)}, タグ: 支払い, ${plan.category}) を生成して紐付けました📝\n` +
				`この予定を消込するとToDoも自動的に完了になります。`,
			todo_id: todo.id,
			plan: toPlanEntry({ ...plan, linked_todo_id: todo.id }),
		});
	},

	// 支払い予定 → 期日前リマインド設定・紐付け（§3.4.3 リマインド連携）
	async linkPlannedPaymentReminder(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		const planId = asOptionalInt(args.plan_id);
		if (planId === undefined) {
			return JSON.stringify({
				success: false,
				message: "plan_id を指定してください。",
			});
		}
		const plan = plannedPaymentRepo.getPlannedPaymentById(
			ctx.userId,
			ctx.botId,
			planId,
		);
		if (!plan) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} が見つかりません。`,
			});
		}
		if (plan.status !== "pending") {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} は${plan.status === "settled" ? "消込済み" : "キャンセル済み"}のためリマインドを設定できません。`,
			});
		}
		if (plan.linked_reminder_id) {
			return JSON.stringify({
				success: false,
				message: `支払い予定 #${planId} には既にリマインド (#${plan.linked_reminder_id}) が紐付いています。`,
			});
		}

		const daysBefore = asOptionalInt(args.days_before) ?? 1;
		if (daysBefore < 0) {
			return JSON.stringify({
				success: false,
				message: "days_before は0以上の整数で指定してください。",
			});
		}

		// 通知時刻: 期日の daysBefore 日前の朝9時
		const due = new Date(`${plan.due_date}T00:00:00`);
		if (Number.isNaN(due.getTime())) {
			return JSON.stringify({
				success: false,
				message: `期日（${plan.due_date}）が日付として解釈できません。`,
			});
		}
		const trigger = new Date(due);
		trigger.setDate(trigger.getDate() - daysBefore);
		trigger.setHours(9, 0, 0, 0);

		if (trigger.getTime() <= Date.now()) {
			return JSON.stringify({
				success: false,
				message:
					`リマインド時刻（期日${daysBefore === 0 ? "当日" : `${daysBefore}日前`}の朝9時）が既に過ぎています。` +
					`days_before を小さくするか、通常のリマインド登録で時刻を直接指定してください。`,
			});
		}

		const reminder = reminderRepo.addReminder(ctx.userId, ctx.botId, {
			message: `支払い予定「${plan.title}」(${formatCurrency(plan.amount)}, ${plan.category}) の期日は ${formatDate(plan.due_date)} です💸`,
			triggerAt: trigger,
			source: "payment",
			sourceId: String(plan.id),
		});
		plannedPaymentRepo.linkReminder(
			ctx.userId,
			ctx.botId,
			plan.id,
			reminder.id,
		);

		return JSON.stringify({
			success: true,
			message:
				`支払い予定「${plan.title}」の期日前リマインドを設定しました⏰ ` +
				`（${reminder.trigger_at.slice(0, 16)} に通知 / リマインドID: #${reminder.id}）`,
			reminder_id: reminder.id,
			trigger_at: reminder.trigger_at,
			plan: toPlanEntry({ ...plan, linked_reminder_id: reminder.id }),
		});
	},
};

// ─── Module Export ───────────────────────────────────────────────────────────

/** 家計管理・支払い予定・消込 FunctionModule（functions/index.ts でレジストリへマージする） */
export const financeFunctions: FunctionModule = {
	declarations,
	handlers,
};
