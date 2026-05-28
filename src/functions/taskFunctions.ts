import * as taskRepo from "../db/taskRepo.js";
import { formatPriority, formatDate, statusEmoji } from "../utils/formatters.js";

export function addTask(
  userId: string,
  args: { title: string; description?: string; due_date?: string; priority?: number }
): string {
  const task = taskRepo.addTask(userId, args.title, args.description, args.due_date, args.priority);
  const priorityLabel = formatPriority(task.priority);
  const dueLabel = task.due_date ? `、期限: ${formatDate(task.due_date)}` : "";
  return JSON.stringify({
    success: true,
    message: `タスク「${task.title}」を追加しました (ID: #${task.id}、優先度: ${priorityLabel}${dueLabel})`,
    task,
  });
}

export function listTasks(
  userId: string,
  args: { status?: string }
): string {
  const tasks = taskRepo.listTasks(userId, args.status);
  if (tasks.length === 0) {
    return JSON.stringify({ success: true, message: "タスクはありません。", tasks: [] });
  }

  const lines = tasks.map(
    (t) =>
      `${statusEmoji(t.status)} #${t.id} ${t.title}${t.due_date ? ` (期限: ${formatDate(t.due_date)})` : ""}`
  );
  return JSON.stringify({
    success: true,
    message: `タスク一覧 (${tasks.length}件):\n${lines.join("\n")}`,
    tasks,
  });
}

export function completeTask(
  userId: string,
  args: { task_id: number }
): string {
  const task = taskRepo.completeTask(args.task_id, userId);
  if (!task) {
    return JSON.stringify({ success: false, message: `タスク #${args.task_id} が見つかりません。` });
  }
  return JSON.stringify({
    success: true,
    message: `タスク「${task.title}」(#${task.id}) を完了にしました✅`,
    task,
  });
}

export function deleteTask(
  userId: string,
  args: { task_id: number }
): string {
  const deleted = taskRepo.deleteTask(args.task_id, userId);
  if (!deleted) {
    return JSON.stringify({ success: false, message: `タスク #${args.task_id} が見つかりません。` });
  }
  return JSON.stringify({
    success: true,
    message: `タスク #${args.task_id} を削除しました🗑️`,
  });
}
