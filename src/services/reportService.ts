import cron from "node-cron";
import { CronExpressionParser } from "cron-parser";
import { EmbedBuilder } from "discord.js";
import { getDb } from "../db/database.js";
import {
  listEnabledReportConfigsAcrossUsers,
  getReportConfig,
  type ReportType,
  type ReportConfigRecord,
} from "../db/reportConfigRepo.js";
import { listSchedulesInRange } from "../db/scheduleRepo.js";
import { parseTodoTags, type TodoRecord } from "../db/todoRepo.js";
import { searchMessages } from "../db/messageLogRepo.js";
import { generateAuxText } from "./llmClient.js";
import { sendToUser } from "./notifier.js";
import { formatCurrency } from "../utils/formatters.js";
import { toDbDateTime } from "../utils/datetime.js";

// ─── 日報・週報の自動生成（§3.8） ────────────────────────────────────────────
// 毎分、有効な配信設定のcron式が現在分にマッチするか判定して生成・配信する
// （node-cronの動的ジョブ管理を避け、設定変更が即時反映されるシンプルな方式）。

let task: cron.ScheduledTask | null = null;

/** cron式が「この1分」にマッチするか判定する */
export function cronMatchesNow(cronExpr: string, now: Date = new Date()): boolean {
  try {
    // 60秒前を起点に次回実行時刻を計算し、現在分と一致するかを確認する
    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(now.getTime() - 60 * 1000),
    });
    const next = interval.next().toDate();
    return (
      next.getFullYear() === now.getFullYear() &&
      next.getMonth() === now.getMonth() &&
      next.getDate() === now.getDate() &&
      next.getHours() === now.getHours() &&
      next.getMinutes() === now.getMinutes()
    );
  } catch {
    return false;
  }
}


interface ReportData {
  periodLabel: string;
  from: string;
  to: string;
  completedTodos: TodoRecord[];
  carryOverTodos: TodoRecord[];
  schedules: { title: string; start_at: string }[];
  payments: { title: string; amount: number; due_date: string; status: string }[];
  incomeTotal: number;
  expenseTotal: number;
  categoryBreakdown: { category: string; total: number }[];
  conversationSamples: string[];
}

/** 当該期間の活動データを集約する（§3.8.2） */
function collectReportData(userId: string, type: ReportType): ReportData {
  const now = new Date();
  const periodMs = type === "daily" ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const fromDate = new Date(now.getTime() - periodMs);
  const from = toDbDateTime(fromDate);
  const to = toDbDateTime(now);
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);

  const db = getDb();

  // 完了タスク: 当該期間内に更新された done（読み取り専用の期間クエリのため直接SQL使用）
  const completedTodos = db
    .prepare(
      `SELECT * FROM todos WHERE user_id = ? AND status = 'done' AND updated_at >= ? AND updated_at <= ?
       ORDER BY updated_at DESC LIMIT 30`
    )
    .all(userId, from, to) as TodoRecord[];

  // 未完了タスク（持ち越し）: open かつ期限が当該期間内
  const carryOverTodos = db
    .prepare(
      `SELECT * FROM todos WHERE user_id = ? AND status = 'open'
       AND due_date IS NOT NULL AND date(due_date) >= date(?) AND date(due_date) <= date(?)
       ORDER BY due_date ASC LIMIT 30`
    )
    .all(userId, fromDay, toDay) as TodoRecord[];

  // カレンダーイベント（schedulesテーブル＝Google同期済みローカルキャッシュから取得）
  const schedules = listSchedulesInRange(userId, from, to).map((s) => ({
    title: s.title,
    start_at: s.start_at,
  }));

  // 支払い予定サマリ: 当該期間に期日を迎えるもの（消込状況含む）
  const payments = db
    .prepare(
      `SELECT title, amount, due_date, status FROM planned_payments
       WHERE user_id = ? AND date(due_date) >= date(?) AND date(due_date) <= date(?)
       ORDER BY due_date ASC LIMIT 20`
    )
    .all(userId, fromDay, toDay) as { title: string; amount: number; due_date: string; status: string }[];

  // 家計サマリ: 当該期間の収支合計・カテゴリ別内訳
  const incomeRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses
       WHERE user_id = ? AND type = 'income' AND date >= ? AND date <= ?`
    )
    .get(userId, fromDay, toDay) as { total: number };
  const expenseRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM expenses
       WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?`
    )
    .get(userId, fromDay, toDay) as { total: number };
  const categoryBreakdown = db
    .prepare(
      `SELECT category, SUM(amount) as total FROM expenses
       WHERE user_id = ? AND type = 'expense' AND date >= ? AND date <= ?
       GROUP BY category ORDER BY total DESC`
    )
    .all(userId, fromDay, toDay) as { category: string; total: number }[];

  // 会話トピック: 期間内のやり取りのサンプル（プライバシー配慮のため要約用素材のみ §3.8.2）
  const messages = searchMessages(userId, { from, to, limit: 40 });
  const conversationSamples = messages
    .filter((m) => m.role === "user")
    .slice(0, 20)
    .map((m) => m.content.slice(0, 100));

  const periodLabel =
    type === "daily"
      ? `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`
      : `${fromDate.getMonth() + 1}/${fromDate.getDate()} 〜 ${now.getMonth() + 1}/${now.getDate()}`;

  return {
    periodLabel,
    from,
    to,
    completedTodos,
    carryOverTodos,
    schedules,
    payments,
    incomeTotal: incomeRow.total,
    expenseTotal: expenseRow.total,
    categoryBreakdown,
    conversationSamples,
  };
}

/** 生データのフォールバックテキストを構築する（LLM生成失敗時 §3.8.3） */
function buildFallbackText(data: ReportData): string {
  const lines: string[] = [];
  lines.push(`✅ 完了タスク: ${data.completedTodos.length}件`);
  for (const t of data.completedTodos.slice(0, 8)) lines.push(`  ・${t.title}`);
  lines.push(`📌 持ち越しタスク: ${data.carryOverTodos.length}件`);
  for (const t of data.carryOverTodos.slice(0, 8)) lines.push(`  ・${t.title}（期限: ${t.due_date}）`);
  if (data.schedules.length > 0) {
    lines.push(`📅 予定: ${data.schedules.length}件`);
    for (const s of data.schedules.slice(0, 8)) lines.push(`  ・${s.title} (${s.start_at})`);
  }
  if (data.payments.length > 0) {
    lines.push(`💳 支払い予定:`);
    for (const p of data.payments) {
      const statusLabel = p.status === "settled" ? "消込済" : p.status === "cancelled" ? "取消" : "未払い";
      lines.push(`  ・${p.title} ${formatCurrency(p.amount)} [${statusLabel}]`);
    }
  }
  lines.push(`💰 収支: 収入 ${formatCurrency(data.incomeTotal)} / 支出 ${formatCurrency(data.expenseTotal)}`);
  return lines.join("\n");
}

/**
 * 日報・週報を生成して配信する（手動実行・テスト配信からも呼ばれる）
 * @returns 送信に成功したか
 */
export async function runReportForUser(userId: string, type: ReportType): Promise<boolean> {
  const config = getReportConfig(userId, type);
  const data = collectReportData(userId, type);
  const typeLabel = type === "daily" ? "日報" : "週報";

  // LLMによるサマリ生成（失敗時は生データへフォールバック §3.8.3）
  let summary: string | null = null;
  try {
    const source = [
      `# 完了タスク（${data.completedTodos.length}件）`,
      ...data.completedTodos.map((t) => `- ${t.title} [${parseTodoTags(t).join("/")}]`),
      `# 持ち越しタスク（${data.carryOverTodos.length}件）`,
      ...data.carryOverTodos.map((t) => `- ${t.title}（期限: ${t.due_date}、優先度: ${t.priority ?? "未設定"}）`),
      `# 予定（${data.schedules.length}件）`,
      ...data.schedules.map((s) => `- ${s.title} (${s.start_at})`),
      `# 支払い予定`,
      ...data.payments.map((p) => `- ${p.title} ${p.amount}円 期日${p.due_date} 状態:${p.status}`),
      `# 家計: 収入${data.incomeTotal}円 / 支出${data.expenseTotal}円`,
      ...data.categoryBreakdown.map((c) => `- ${c.category}: ${c.total}円`),
      `# 会話トピックの素材（ユーザー発言の抜粋。詳細は書かずトピック傾向のみ要約すること）`,
      ...data.conversationSamples.map((s) => `- ${s}`),
    ].join("\n");

    summary = await generateAuxText(
      userId,
      `以下は${typeLabel}（対象期間: ${data.periodLabel}）の活動データです。` +
        `Discord通知用の${typeLabel}サマリを日本語で簡潔に生成してください（800文字以内）。` +
        `構成: 1)タスクの進捗 2)予定・支払いのトピック 3)家計サマリ 4)主な会話トピック（プライバシーに配慮し詳細は省く） 5)ひとことコメント。` +
        `サマリ本文のみを出力してください。\n\n${source}`
    );
  } catch (err) {
    console.warn(`[Report] LLMサマリ生成に失敗しました (user: ${userId}):`, err);
  }

  const body = summary?.trim() || buildFallbackText(data);

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${typeLabel} ${data.periodLabel}`)
    .setColor(0x5865f2) // 通常情報ブルー（§3.0.2）
    .setDescription(body.slice(0, 4000))
    .addFields(
      { name: "✅ 完了", value: `${data.completedTodos.length}件`, inline: true },
      { name: "📌 持ち越し", value: `${data.carryOverTodos.length}件`, inline: true },
      {
        name: "💰 収支",
        value: `+${formatCurrency(data.incomeTotal)} / -${formatCurrency(data.expenseTotal)}`,
        inline: true,
      }
    )
    .setFooter({ text: summary ? "Yuuka 自動生成レポート" : "Yuuka レポート（生データ）" })
    .setTimestamp();

  return sendToUser(
    userId,
    { embeds: [embed] },
    config ? { type: config.target_type, id: config.target_id ?? undefined } : undefined
  );
}

async function tick(): Promise<void> {
  const now = new Date();
  let configs: ReportConfigRecord[];
  try {
    configs = listEnabledReportConfigsAcrossUsers();
  } catch (err) {
    console.error("[Report] 配信設定の取得に失敗しました:", err);
    return;
  }

  for (const conf of configs) {
    if (!cronMatchesNow(conf.schedule_cron, now)) continue;
    console.log(`📋 [Report] ${conf.type} レポートを生成します (user: ${conf.user_id})`);
    try {
      await runReportForUser(conf.user_id, conf.type);
    } catch (err) {
      console.error(`[Report] レポート配信に失敗しました (user: ${conf.user_id}):`, err);
    }
  }
}

export function startReportService(): void {
  if (task) return;
  task = cron.schedule("* * * * *", () => {
    void tick();
  });
  console.log("📋 日報・週報サービスを開始しました（毎分cron判定）");
}

export function stopReportService(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
