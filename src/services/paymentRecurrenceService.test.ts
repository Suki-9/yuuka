import { describe, expect, it } from "vitest";
import { calcNextRecurringDueDate } from "./paymentRecurrenceService.js";

describe("calcNextRecurringDueDate", () => {
	it("月次 cron から YYYY-MM-DD 形式の次回期日を返す", () => {
		const next = calcNextRecurringDueDate("0 0 1 * *", "2020-01-01");
		expect(next).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("過去起点でも「今日以降」の occurrence へ繰り越す", () => {
		const next = calcNextRecurringDueDate("0 0 1 * *", "2010-01-01");
		expect(next).not.toBeNull();
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		expect(new Date(`${next}T00:00:00`).getTime()).toBeGreaterThanOrEqual(
			today.getTime(),
		);
	});

	it("毎月27日のルールは日が27の期日を返す", () => {
		const next = calcNextRecurringDueDate("0 0 27 * *", "2020-01-01");
		expect(next).not.toBeNull();
		expect(next?.endsWith("-27")).toBe(true);
	});

	it("不正な cron 式・空文字は null", () => {
		expect(calcNextRecurringDueDate("not-a-cron", "2020-01-01")).toBeNull();
		expect(calcNextRecurringDueDate("", "2020-01-01")).toBeNull();
	});

	it("不正な fromDueDate でも例外を投げず文字列か null を返す", () => {
		const next = calcNextRecurringDueDate("0 0 1 * *", "garbage");
		expect(next === null || /^\d{4}-\d{2}-\d{2}$/.test(next)).toBe(true);
	});
});
