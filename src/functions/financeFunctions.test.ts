import { describe, expect, it } from "vitest";
import {
	asOptionalInt,
	asOptionalString,
	formatBalance,
	isYmd,
	todayYmd,
} from "./financeFunctions.js";

describe("asOptionalString", () => {
	it("文字列はトリムして返し、空・非文字列は undefined", () => {
		expect(asOptionalString(" hi ")).toBe("hi");
		expect(asOptionalString("   ")).toBeUndefined();
		expect(asOptionalString(123)).toBeUndefined();
		expect(asOptionalString(undefined)).toBeUndefined();
		expect(asOptionalString(null)).toBeUndefined();
	});
});

describe("asOptionalInt", () => {
	it("有限数を切り捨て整数化し、非数・NaN・Infinity は undefined", () => {
		expect(asOptionalInt(3.7)).toBe(3);
		expect(asOptionalInt(-2.9)).toBe(-2);
		expect(asOptionalInt(0)).toBe(0);
		expect(asOptionalInt(Number.NaN)).toBeUndefined();
		expect(asOptionalInt(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(asOptionalInt("5")).toBeUndefined();
	});
});

describe("isYmd", () => {
	it("YYYY-MM-DD のみ true", () => {
		expect(isYmd("2026-06-23")).toBe(true);
		expect(isYmd("2026-6-3")).toBe(false);
		expect(isYmd("2026/06/23")).toBe(false);
		expect(isYmd("not-a-date")).toBe(false);
	});
});

describe("todayYmd", () => {
	it("YYYY-MM-DD 形式の今日を返す", () => {
		expect(todayYmd()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(isYmd(todayYmd())).toBe(true);
	});
});

describe("formatBalance", () => {
	it("符号付きで整形する (0 と正は +、負は -)", () => {
		expect(formatBalance(0).startsWith("+")).toBe(true);
		expect(formatBalance(100).startsWith("+")).toBe(true);
		expect(formatBalance(-100).startsWith("-")).toBe(true);
	});

	it("3桁区切りの金額を含む", () => {
		expect(formatBalance(12000)).toContain("12,000");
		expect(formatBalance(-3400)).toContain("3,400");
	});
});
