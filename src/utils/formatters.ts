/**
 * 金額を3桁カンマ区切りでフォーマット
 */
export function formatCurrency(amount: number): string {
  return `¥${amount.toLocaleString("ja-JP")}`;
}

/**
 * ISO 8601 日時文字列を日本語の読みやすい形式にフォーマット
 */
export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

/**
 * 日付文字列 (YYYY-MM-DD) を日本語フォーマット
 */
export function formatDate(dateStr: string): string {
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const [year, month, day] = parts;
  return `${year}年${parseInt(month!)}月${parseInt(day!)}日`;
}

/**
 * 優先度の数値を絵文字付きテキストに変換
 */
export function formatPriority(priority: number): string {
  switch (priority) {
    case 2:
      return "🔴 高";
    case 1:
      return "🟡 中";
    default:
      return "🔵 低";
  }
}

/**
 * タスクステータスの絵文字
 */
export function statusEmoji(status: string): string {
  switch (status) {
    case "done":
      return "✅";
    case "pending":
      return "⬜";
    default:
      return "❓";
  }
}

/**
 * 現在の日本語の年月を返す（例: "2026年5月"）
 */
export function currentMonthLabel(year?: number, month?: number): string {
  const now = new Date();
  const y = year ?? now.getFullYear();
  const m = month ?? now.getMonth() + 1;
  return `${y}年${m}月`;
}
