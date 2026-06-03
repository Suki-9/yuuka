import * as expenseRepo from "../db/expenseRepo.js";
import { formatCurrency, formatDate, currentMonthLabel } from "../utils/formatters.js";
import { CATEGORIES } from "../db/expenseRepo.js";

export function addExpense(
  userId: string,
  args: {
    amount: number;
    category: string;
    description?: string;
    date?: string;
    source?: string;
  }
): string {
  const expense = expenseRepo.addExpense(
    userId,
    args.amount,
    args.category,
    args.description,
    args.date,
    args.source ?? "manual"
  );
  return JSON.stringify({
    success: true,
    message: `${formatCurrency(expense.amount)} (${expense.category}) を記録しました${expense.description ? ` — ${expense.description}` : ""}`,
    expense,
  });
}

export function getMonthlySummary(
  userId: string,
  args: { year?: number; month?: number }
): string {
  const breakdown = expenseRepo.getMonthlyCategoryBreakdown(userId, args.year, args.month);
  const total = expenseRepo.getMonthlyTotal(userId, args.year, args.month);
  const label = currentMonthLabel(args.year, args.month);

  if (breakdown.length === 0) {
    return JSON.stringify({
      success: true,
      message: `${label}の支出記録はありません。`,
      total: 0,
      breakdown: [],
    });
  }

  const lines = breakdown.map(
    (c) => `${c.category}: ${formatCurrency(c.total)} (${c.count}件)`
  );
  lines.push(`───────────`);
  lines.push(`合計: ${formatCurrency(total)}`);

  return JSON.stringify({
    success: true,
    message: `${label}の支出サマリー:\n${lines.join("\n")}`,
    total,
    breakdown,
  });
}

export function getCategoryBreakdown(
  userId: string,
  args: { year?: number; month?: number }
): string {
  const breakdown = expenseRepo.getMonthlyCategoryBreakdown(userId, args.year, args.month);
  const total = expenseRepo.getMonthlyTotal(userId, args.year, args.month);
  const label = currentMonthLabel(args.year, args.month);

  if (breakdown.length === 0) {
    return JSON.stringify({
      success: true,
      message: `${label}の支出記録はありません。`,
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
    message: `${label}のカテゴリ別内訳:\n${lines.join("\n")}\n合計: ${formatCurrency(total)}`,
    total,
    breakdown,
  });
}

export function listRecentExpenses(
  userId: string,
  args: { count?: number }
): string {
  const expenses = expenseRepo.listRecentExpenses(userId, args.count ?? 10);
  if (expenses.length === 0) {
    return JSON.stringify({
      success: true,
      message: "支出の記録はありません。",
      expenses: [],
    });
  }

  const lines = expenses.map((e) => {
    const desc = e.description ? ` — ${e.description}` : "";
    return `${formatDate(e.date)} | ${e.category} | ${formatCurrency(e.amount)}${desc}`;
  });

  return JSON.stringify({
    success: true,
    message: `直近の支出:\n${lines.join("\n")}`,
    expenses,
  });
}

// ── 予算上限 ──

export function getBudgetLimits(botId: string): string {
  const limits = expenseRepo.getBudgetLimits(botId);
  if (limits.length === 0) {
    return JSON.stringify({
      success: true,
      message: "予算上限が設定されているカテゴリはありません。",
      limits: [],
    });
  }
  const lines = limits.map(l => `${l.category}: ${formatCurrency(l.limit_amount)}`);
  return JSON.stringify({
    success: true,
    message: `設定済み予算上限:\n${lines.join("\n")}`,
    limits,
  });
}

export function setBudgetLimit(
  botId: string,
  args: { category: string; limit_amount: number }
): string {
  if (!CATEGORIES.includes(args.category as any)) {
    return JSON.stringify({ success: false, message: `無効なカテゴリです: ${args.category}` });
  }
  if (args.limit_amount <= 0) {
    return JSON.stringify({ success: false, message: "limit_amount は1以上の整数で指定してください。" });
  }
  expenseRepo.upsertBudgetLimit(botId, args.category, args.limit_amount);
  return JSON.stringify({
    success: true,
    message: `${args.category} の月間予算上限を ${formatCurrency(args.limit_amount)} に設定しました。`,
  });
}

export function deleteBudgetLimit(
  botId: string,
  args: { category: string }
): string {
  expenseRepo.deleteBudgetLimit(botId, args.category);
  return JSON.stringify({
    success: true,
    message: `${args.category} の予算上限を削除しました。`,
  });
}

// ── 支払い予定 ──

export function listExpensePlans(
  botId: string,
  args: { include_paid?: boolean }
): string {
  const plans = expenseRepo.listExpensePlans(botId, args.include_paid ?? false);
  if (plans.length === 0) {
    return JSON.stringify({
      success: true,
      message: args.include_paid ? "支払い予定はありません。" : "未払いの支払い予定はありません。",
      plans: [],
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  const lines = plans.map(p => {
    const overdue = !p.is_paid && p.planned_date <= today ? " ⚠️ 期限超過" : "";
    const status = p.is_paid ? " ✅ 支払済" : "";
    return `#${p.id} [${p.planned_date}] ${p.title} — ${p.category} ${formatCurrency(p.amount)}${overdue}${status}`;
  });
  return JSON.stringify({
    success: true,
    message: `支払い予定 (${plans.length}件):\n${lines.join("\n")}`,
    plans,
  });
}

export function addExpensePlan(
  botId: string,
  args: { title: string; amount: number; category: string; planned_date: string; description?: string }
): string {
  if (!CATEGORIES.includes(args.category as any)) {
    return JSON.stringify({ success: false, message: `無効なカテゴリです: ${args.category}` });
  }
  if (args.amount <= 0) {
    return JSON.stringify({ success: false, message: "amount は1以上の整数で指定してください。" });
  }
  const plan = expenseRepo.addExpensePlan(
    botId,
    args.title,
    args.amount,
    args.category,
    args.planned_date,
    args.description
  );
  return JSON.stringify({
    success: true,
    message: `支払い予定「${plan.title}」(${formatCurrency(plan.amount)}, ${plan.planned_date}) を登録しました。`,
    plan,
  });
}

export function payExpensePlan(
  botId: string,
  args: { plan_id: number }
): string {
  const plans = expenseRepo.listExpensePlans(botId, true);
  const plan = plans.find(p => p.id === args.plan_id);
  if (!plan) {
    return JSON.stringify({ success: false, message: `支払い予定 #${args.plan_id} が見つかりません。` });
  }
  if (plan.is_paid) {
    return JSON.stringify({ success: false, message: `支払い予定 #${args.plan_id} は既に支払済みです。` });
  }
  const expense = expenseRepo.addExpense(botId, plan.amount, plan.category, plan.title, undefined, undefined, "plan");
  expenseRepo.markExpensePlanPaid(args.plan_id, botId, expense.id);
  return JSON.stringify({
    success: true,
    message: `「${plan.title}」${formatCurrency(plan.amount)} の支払いを完了し、家計簿に記録しました。`,
    expense,
  });
}

export function deleteExpensePlan(
  botId: string,
  args: { plan_id: number }
): string {
  const ok = expenseRepo.deleteExpensePlan(args.plan_id, botId);
  if (!ok) {
    return JSON.stringify({ success: false, message: `支払い予定 #${args.plan_id} が見つからないか、すでに削除されています。` });
  }
  return JSON.stringify({
    success: true,
    message: `支払い予定 #${args.plan_id} を削除しました。`,
  });
}
