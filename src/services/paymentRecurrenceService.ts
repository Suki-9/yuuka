import { CronExpressionParser } from "cron-parser";
import cron from "node-cron";
import {
	advanceRecurring,
	listOverdueRecurringAcrossUsers,
} from "../db/plannedPaymentRepo.js";

// ─── 支払い予定 繰り返し自動生成サービス（§3.4.3） ───────────────────────────
//
// 毎日 0:05 に repeat_rule（cron式）付きで期日を過ぎた pending の支払い予定を走査し、
// cron-parser で次回期日を計算して advanceRecurring（元の行を処理済みにして
// 次回期日の新しい pending 行を生成）する。
// 期日前通知は本サービスでは行わない（ユーザーが linkPlannedPaymentReminder で
// リマインド連携を明示設定する方式のため。§3.4.3 ToDo・リマインド連携）。

let task: cron.ScheduledTask | null = null;

/** 処理の多重起動防止フラグ */
let ticking = false;

// ─── 次回期日の計算 ──────────────────────────────────────────────────────────

function formatYmd(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * repeat_rule（cron式）から次回の支払い期日（'YYYY-MM-DD'）を計算する。
 * 元の期日を起点に次回を求め、長期停止などで複数周期を跨いでいた場合は
 * 今日以降の直近の期日まで読み飛ばす（過去期日の pending 行を量産しないため）。
 * @returns 次回期日。cron式が解釈できない場合は null
 */
export function calcNextRecurringDueDate(
	repeatRule: string,
	fromDueDate: string,
): string | null {
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	let cursor = new Date(`${fromDueDate}T00:00:00`);
	if (Number.isNaN(cursor.getTime())) cursor = new Date();

	try {
		// 安全弁: 異常なcron式で無限に進まないよう反復回数に上限を設ける
		for (let i = 0; i < 1000; i++) {
			const next = CronExpressionParser.parse(repeatRule, {
				currentDate: cursor,
			})
				.next()
				.toDate();
			if (next.getTime() >= today.getTime()) return formatYmd(next);
			cursor = next;
		}
		return null;
	} catch {
		return null;
	}
}

// ─── ティック実行 ────────────────────────────────────────────────────────────

async function runTick(): Promise<void> {
	if (ticking) return; // 前回の処理が長引いている場合はスキップ
	ticking = true;
	try {
		// cron用の全ユーザー走査（plannedPaymentRepo 側に例外コメントあり）
		const overdue = listOverdueRecurringAcrossUsers();

		for (const plan of overdue) {
			try {
				if (!plan.repeat_rule) continue; // リポジトリ側フィルタの保険

				const nextDue = calcNextRecurringDueDate(
					plan.repeat_rule,
					plan.due_date,
				);
				if (!nextDue) {
					// cron式が壊れている場合はスキップ（行は pending のまま残し、修正を待つ）
					console.error(
						`❌ repeat_rule の解釈に失敗したためスキップします (plan #${plan.id}, rule: ${plan.repeat_rule}, user: ${plan.user_id})`,
					);
					continue;
				}

				const created = advanceRecurring(plan.id, nextDue);
				if (created) {
					console.log(
						`🔁 繰り返し支払い予定を次回へ更新: 「${plan.title}」 #${plan.id} → #${created.id} (期日: ${nextDue}, user: ${plan.user_id})`,
					);
				}
			} catch (err) {
				console.error(
					`❌ 繰り返し支払い予定の処理エラー (plan #${plan.id}):`,
					err,
				);
			}
		}
	} catch (err) {
		console.error(
			"❌ 支払い予定繰り返しサービスのティック処理でエラーが発生しました:",
			err,
		);
	} finally {
		ticking = false;
	}
}

// ─── 開始 / 停止 ─────────────────────────────────────────────────────────────

/**
 * 支払い予定の繰り返し自動生成サービスを開始する（§3.4.3）。
 * 毎日午前0時5分の定期実行に加え、起動直後にも一度実行して
 * 停止中に期日を跨いだ繰り返し予定を復帰処理する（§10）。
 */
export function startPaymentRecurrenceService(): void {
	if (task) {
		console.log("💳 支払い予定繰り返しサービスは既に開始されています");
		return;
	}

	task = cron.schedule("5 0 * * *", () => {
		void runTick();
	});

	console.log("💳 支払い予定繰り返しサービス開始 (毎日 0:05)");

	// 起動時の復帰処理
	void runTick();
}

/** 支払い予定の繰り返し自動生成サービスを停止する */
export function stopPaymentRecurrenceService(): void {
	if (task) {
		task.stop();
		task = null;
		console.log("💳 支払い予定繰り返しサービス停止");
	}
}
