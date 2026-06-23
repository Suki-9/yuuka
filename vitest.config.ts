import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Node 環境（DOM 不要）。純ロジックの単体テストのみを対象とする。
		environment: "node",
		include: ["src/**/*.test.ts"],
		// 実 DB / 外部サービスに触れる重い結合テストは現状対象外（純関数を優先カバー）。
	},
});
