import type { FunctionDeclaration } from "@google/generative-ai";
import { describe, expect, it } from "vitest";
import {
	buildToolIndex,
	estimateHeuristicWeightMs,
	isHeavyTool,
} from "./turnPlanner.js";

describe("isHeavyTool", () => {
	it("既知の重いツール名を true と判定する", () => {
		expect(isHeavyTool("searchWeb")).toBe(true);
		expect(isHeavyTool("fetchDynamicPage")).toBe(true);
		expect(isHeavyTool("takePageScreenshot")).toBe(true);
	});

	it("browserInteractive 接頭辞のツールを true と判定する", () => {
		expect(isHeavyTool("browserInteractiveClick")).toBe(true);
		expect(isHeavyTool("browserInteractiveType")).toBe(true);
	});

	it("軽いツール・空文字は false", () => {
		expect(isHeavyTool("addTodo")).toBe(false);
		expect(isHeavyTool("recordExpense")).toBe(false);
		expect(isHeavyTool("")).toBe(false);
	});
});

describe("estimateHeuristicWeightMs", () => {
	const base = { text: "", imageCount: 0, hasAudio: false };

	it("無害なテキスト・入力なしは 0", () => {
		expect(estimateHeuristicWeightMs({ ...base, text: "こんにちは" })).toBe(0);
	});

	it("ログイン/操作系は最も重い (検索系より大きい)", () => {
		const login = estimateHeuristicWeightMs({ ...base, text: "ログインして" });
		const search = estimateHeuristicWeightMs({
			...base,
			text: "最新ニュースを検索して",
		});
		expect(login).toBeGreaterThan(0);
		expect(search).toBeGreaterThan(0);
		expect(login).toBeGreaterThan(search);
	});

	it("画像枚数に比例してウェイトが増える (単調)", () => {
		const one = estimateHeuristicWeightMs({ ...base, imageCount: 1 });
		const three = estimateHeuristicWeightMs({ ...base, imageCount: 3 });
		expect(three).toBeGreaterThan(one);
	});

	it("音声入力でウェイトが付く", () => {
		expect(
			estimateHeuristicWeightMs({ ...base, hasAudio: true }),
		).toBeGreaterThan(0);
	});
});

describe("buildToolIndex", () => {
	it("name と説明の先頭一文 (。まで) で索引行を作る", () => {
		const decls = [
			{ name: "foo", description: "これは説明です。詳細は無視される" },
		] as FunctionDeclaration[];
		expect(buildToolIndex(decls)).toBe("- foo: これは説明です");
	});

	it("空白・改行は単一スペースに畳んでから切り出す", () => {
		const decls = [
			{ name: "bar", description: "二つ目\n  改行は空白化される" },
		] as FunctionDeclaration[];
		// replace(/\s+/g, " ") が先に走るため改行は分割境界にならない
		expect(buildToolIndex(decls)).toBe("- bar: 二つ目 改行は空白化される");
	});

	it("説明が無い場合も name 行を出す", () => {
		const decls = [{ name: "noDesc" }] as FunctionDeclaration[];
		expect(buildToolIndex(decls)).toBe("- noDesc: ");
	});
});
