import { EmbedBuilder } from "discord.js";
import type { Task } from "../db/taskRepo.js";
import type { Schedule } from "../db/scheduleRepo.js";
import type { CategoryTotal, Expense } from "../db/expenseRepo.js";
import {
  formatCurrency,
  formatDateTime,
  formatDate,
  formatPriority,
  statusEmoji,
  currentMonthLabel,
} from "./formatters.js";

/** 統一テーマカラー */
const THEME_COLOR = 0x5865f2; // Discord Blurple
const SUCCESS_COLOR = 0x57f287;
const WARNING_COLOR = 0xfee75c;
const EXPENSE_COLOR = 0xed4245;

export function buildTaskListEmbed(tasks: Task[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("📋 タスク一覧")
    .setColor(THEME_COLOR)
    .setTimestamp();

  if (tasks.length === 0) {
    embed.setDescription("タスクはありません。");
    return embed;
  }

  const lines = tasks.map((t) => {
    const emoji = statusEmoji(t.status);
    const priority = t.priority > 0 ? ` ${formatPriority(t.priority)}` : "";
    const due = t.due_date ? ` (期限: ${formatDate(t.due_date)})` : "";
    return `${emoji} **#${t.id}** ${t.title}${priority}${due}`;
  });

  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: `全${tasks.length}件` });
  return embed;
}

export function buildTaskAddedEmbed(task: Task): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📝 タスクを追加しました")
    .setColor(SUCCESS_COLOR)
    .addFields(
      { name: "タスク", value: `#${task.id} ${task.title}`, inline: true },
      { name: "優先度", value: formatPriority(task.priority), inline: true },
      ...(task.due_date
        ? [{ name: "期限", value: formatDate(task.due_date), inline: true }]
        : [])
    )
    .setTimestamp();
}

export function buildScheduleListEmbed(schedules: Schedule[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("📅 今後の予定")
    .setColor(THEME_COLOR)
    .setTimestamp();

  if (schedules.length === 0) {
    embed.setDescription("予定はありません。");
    return embed;
  }

  const lines = schedules.map((s) => {
    const time = formatDateTime(s.start_at);
    const remind = s.remind_before_minutes > 0 ? ` 🔔${s.remind_before_minutes}分前` : "";
    return `📌 **#${s.id}** ${s.title}\n　　${time}${remind}`;
  });

  embed.setDescription(lines.join("\n\n"));
  embed.setFooter({ text: `全${schedules.length}件` });
  return embed;
}

export function buildScheduleAddedEmbed(schedule: Schedule): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📅 予定を登録しました")
    .setColor(SUCCESS_COLOR)
    .addFields(
      { name: "予定", value: schedule.title, inline: true },
      { name: "日時", value: formatDateTime(schedule.start_at), inline: true },
      {
        name: "リマインド",
        value: `${schedule.remind_before_minutes}分前`,
        inline: true,
      }
    )
    .setTimestamp();
}

export function buildReminderEmbed(schedule: Schedule): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🔔 リマインダー")
    .setColor(WARNING_COLOR)
    .setDescription(
      `**${schedule.title}** の時間が近づいています！\n\n📅 ${formatDateTime(schedule.start_at)}`
    )
    .setTimestamp();
}

export function buildExpenseAddedEmbed(expense: Expense): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("💰 支出を記録しました")
    .setColor(EXPENSE_COLOR)
    .addFields(
      { name: "金額", value: formatCurrency(expense.amount), inline: true },
      { name: "カテゴリ", value: expense.category, inline: true },
      { name: "日付", value: formatDate(expense.date), inline: true },
      ...(expense.description
        ? [{ name: "メモ", value: expense.description, inline: false }]
        : [])
    )
    .setTimestamp();
}

export function buildMonthlySummaryEmbed(
  breakdown: CategoryTotal[],
  total: number,
  year?: number,
  month?: number
): EmbedBuilder {
  const label = currentMonthLabel(year, month);
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${label}の支出サマリー`)
    .setColor(EXPENSE_COLOR)
    .setTimestamp();

  if (breakdown.length === 0) {
    embed.setDescription("支出の記録はありません。");
    return embed;
  }

  const lines = breakdown.map(
    (c) => `${categoryEmoji(c.category)} **${c.category}**: ${formatCurrency(c.total)} (${c.count}件)`
  );
  lines.push(`\n━━━━━━━━━━━━━━━\n💴 **合計: ${formatCurrency(total)}**`);

  embed.setDescription(lines.join("\n"));
  return embed;
}

export function buildRecentExpensesEmbed(expenses: Expense[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle("📜 直近の支出履歴")
    .setColor(EXPENSE_COLOR)
    .setTimestamp();

  if (expenses.length === 0) {
    embed.setDescription("支出の記録はありません。");
    return embed;
  }

  const lines = expenses.map((e) => {
    const desc = e.description ? ` - ${e.description}` : "";
    return `${formatDate(e.date)} | ${categoryEmoji(e.category)} ${e.category} | ${formatCurrency(e.amount)}${desc}`;
  });

  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: `${expenses.length}件表示` });
  return embed;
}

export function buildReceiptParsedEmbed(
  storeName: string,
  date: string,
  items: Array<{ name: string; amount: number; category: string }>,
  total: number
): EmbedBuilder {
  const lines = items.map(
    (item) => `・${item.name} ${formatCurrency(item.amount)} (${item.category})`
  );

  return new EmbedBuilder()
    .setTitle("🧾 レシートを読み取りました")
    .setColor(SUCCESS_COLOR)
    .addFields(
      { name: "店舗", value: storeName, inline: true },
      { name: "日付", value: formatDate(date), inline: true },
      { name: "合計", value: formatCurrency(total), inline: true },
      { name: "明細", value: lines.join("\n") || "なし" }
    )
    .setTimestamp();
}

// ─── リッチコンテンツEmbed ──────────────────────────────────────────────

const COLOR_MAP: Record<string, number> = {
  default: THEME_COLOR,
  success: SUCCESS_COLOR,
  warning: WARNING_COLOR,
  error: EXPENSE_COLOR,
  info: 0x5bc0eb,
  weather: 0x4fc3f7,
  news: 0xf5a623,
  data: 0x9b59b6,
};

export interface RichContentField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface RichContentData {
  title: string;
  description?: string;
  color?: string;
  thumbnail_url?: string;
  image_url?: string;
  fields?: RichContentField[];
  footer?: string;
}

export function buildRichContentEmbed(data: RichContentData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(data.title)
    .setColor(COLOR_MAP[data.color ?? "default"] ?? THEME_COLOR)
    .setTimestamp();

  if (data.description) embed.setDescription(data.description);

  if (data.fields && data.fields.length > 0) {
    embed.addFields(
      data.fields.map((f) => ({
        name: f.name,
        value: f.value,
        inline: f.inline ?? false,
      }))
    );
  }

  if (data.thumbnail_url) embed.setThumbnail(data.thumbnail_url);
  if (data.image_url) embed.setImage(data.image_url);
  if (data.footer) embed.setFooter({ text: data.footer });

  return embed;
}

function categoryEmoji(category: string): string {
  const map: Record<string, string> = {
    食費: "🍽️",
    日用品: "🏠",
    交通費: "🚃",
    光熱費: "💡",
    通信費: "📱",
    医療費: "🏥",
    娯楽: "🎮",
    衣服: "👕",
    その他: "📦",
  };
  return map[category] ?? "📦";
}
