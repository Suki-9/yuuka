import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// dev-hot(compose)標準フロー = 7855 / ホスト直 tsx watch(dev:host) = 7854
// prod の HOST_PORT は環境毎に異なる(dev=7855, prod=7701 等)ため、必ず env で切替可能に
const API = process.env.VITE_API_TARGET ?? "http://127.0.0.1:7855";

export default defineConfig({
	root: __dirname,
	base: "/", // ★デフォルト維持（/theme-init.js 等の絶対パス参照が書き換わらないよう）
	publicDir: "public",
	build: {
		outDir: "../dist/public",
		emptyOutDir: true, // dist/public 配下のみクリア（dist/ 直下の tsgo 出力は無事）
		assetsDir: "assets", // ★固定: ハッシュ資産を assets/ 直下に集約（chunk 含む）
		assetsInlineLimit: 0, // CSP script-src 'self' 準拠: inline module/data-URI を出さない
	},
	plugins: [svelte()],
	resolve: {
		alias: {
			// SvelteKit 風 import 記法（$lib/...）を frontend/src/lib へ解決
			$lib: path.resolve(__dirname, "src/lib"),
		},
	},
	server: {
		port: 5173,
		// 真に必要なのは /api と /ws/chat のみ（§5.6 参照）
		proxy: {
			"/api": { target: API, changeOrigin: false },
			"/ws/chat": {
				target: API.replace("http", "ws"),
				ws: true,
				changeOrigin: false,
			},
		},
	},
});
