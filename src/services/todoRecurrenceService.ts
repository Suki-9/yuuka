import cron from "node-cron";
import {
	advanceRoutine,
	endRoutineById,
	listOverdueRoutinesAcrossUsers,
} from "../db/todoRepo.js";
import { calcNextRecurringDueDate } from "./paymentRecurrenceService.js";

// ─── ルーチン（繰り返し）タスク 自動生成サービス（§3.2 v16） ─────────────────
//
// 毎日 0:10 に repeat_rule（cron式）付きで期日を過ぎたルーチンタスクを走査し、
// cron-parser で次回期日を計算して advanceRoutine（同一行の due_date を次回へ進め、
// 状態・進捗・リマインド済みフラグをリセット）する。支払い予定（paymentRecurrenceService）
// と異なり行を増やさず同一行を進める方針（reminder の rescheduleRepeat と同方針＝山積み防止）。
// 期日前の通知は既存のリマインドエンジン（ToDo期限24h以内通知）が自動で行う。
//
// 終了条件（どちらかを満たしたら repeat_* をクリアして単発タスクに戻す）:
//   1. 終了指示（ユーザーが stopTodoRoutine を呼ぶ。todoFunctions 側で処理）
//   2. 登録時指定:
//      - repeat_until（終了日）: 次回期日がこれを越えたら終了（現在の1件を最終とする）
//      - repeat_count（残り回数。現在分を含む）: 1 以下なら今が最終回として終了する

let task: cron.ScheduledTask | null = null;

/** 処理の多重起動防止フラグ */
let ticking = false;

async function runTick(): Promise<void> {
	if (ticking) return; // 前回の処理が長引いている場合はスキップ
	ticking = true;
	try {
		// cron用の全ユーザー走査（todoRepo 側に例外コメントあり）
		const overdue = listOverdueRoutinesAcrossUsers();

		for (const todo of overdue) {
			try {
				if (!todo.repeat_rule || !todo.due_date) continue; // リポジトリ側フィルタの保険

				// 終了条件2-b: 残り回数が 1 以下なら今回が最終回 → 繰り返しを終了する
				if (todo.repeat_count !== null && todo.repeat_count <= 1) {
					endRoutineById(todo.id);
					console.log(
						`🏁 ルーチン終了（回数消化）: 「${todo.title}」 #${todo.id} (user: ${todo.user_id})`,
					);
					continue;
				}

				const nextDue = calcNextRecurringDueDate(
					todo.repeat_rule,
					todo.due_date,
				);
				if (!nextDue) {
					// cron式が壊れている場合はスキップ（行はそのまま残し、修正を待つ）
					console.error(
						`❌ repeat_rule の解釈に失敗したためスキップします (todo #${todo.id}, rule: ${todo.repeat_rule}, user: ${todo.user_id})`,
					);
					continue;
				}

				// 終了条件2-a: 次回期日が終了日を越えるなら繰り返しを終了する（現在の1件を最終とする）
				if (todo.repeat_until && nextDue > todo.repeat_until) {
					endRoutineById(todo.id);
					console.log(
						`🏁 ルーチン終了（終了日到達）: 「${todo.title}」 #${todo.id} (until: ${todo.repeat_until}, user: ${todo.user_id})`,
					);
					continue;
				}

				const nextCount =
					todo.repeat_count !== null ? todo.repeat_count - 1 : null;
				const updated = advanceRoutine(todo.id, nextDue, nextCount);
				if (updated) {
					console.log(
						`🔁 ルーチンタスクを次回へ更新: 「${todo.title}」 #${todo.id} → 期日 ${nextDue}` +
							`${nextCount !== null ? `（残り${nextCount}回）` : ""} (user: ${todo.user_id})`,
					);
				}
			} catch (err) {
				console.error(`❌ ルーチンタスクの処理エラー (todo #${todo.id}):`, err);
			}
		}
	} catch (err) {
		console.error(
			"❌ ルーチンタスクサービスのティック処理でエラーが発生しました:",
			err,
		);
	} finally {
		ticking = false;
	}
}

// ─── 開始 / 停止 ─────────────────────────────────────────────────────────────

/**
 * ルーチンタスクの自動生成サービスを開始する（§3.2 v16）。
 * 毎日午前0時10分の定期実行に加え、起動直後にも一度実行して
 * 停止中に期日を跨いだルーチンを復帰処理する（§10）。
 * 0:05 の支払い予定サービスと時刻をずらして負荷の集中を避ける。
 */
export function startTodoRecurrenceService(): void {
	if (task) {
		console.log("🔁 ルーチンタスクサービスは既に開始されています");
		return;
	}

	task = cron.schedule("10 0 * * *", () => {
		void runTick();
	});

	console.log("🔁 ルーチンタスクサービス開始 (毎日 0:10)");

	// 起動時の復帰処理
	void runTick();
}

/** ルーチンタスクの自動生成サービスを停止する */
export function stopTodoRecurrenceService(): void {
	if (task) {
		task.stop();
		task = null;
		console.log("🔁 ルーチンタスクサービス停止");
	}
}
