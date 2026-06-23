import fs from "node:fs";
import path from "node:path";
import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";

// ─── デスクトップクライアント: 配布（ダウンロード）─────────────────────────────
// Windows 版 yuuka-desktop.exe をダッシュボードから配布する。
// バイナリは Docker ビルド（desktop-builder ステージ）でクロスコンパイルされ、
// 配布ディレクトリ（既定 dist/downloads）へ配置される。ローカル開発でファイルが
// 無い場合は info で available:false を返し、ダッシュボード側がその旨を表示する。

const DOWNLOAD_DIR =
	process.env.DESKTOP_DOWNLOAD_DIR ||
	path.resolve(process.cwd(), "dist", "downloads");
const EXE_NAME = "yuuka-desktop.exe";
const EXE_PATH = path.join(DOWNLOAD_DIR, EXE_NAME);
const VERSION_PATH = path.join(DOWNLOAD_DIR, "version.txt");

/** 配布バイナリのメタ情報を取得（存在しなければ available:false）。 */
function readDesktopMeta(): {
	available: boolean;
	filename: string;
	size: number;
	version: string;
	built_at: string | null;
} {
	try {
		const stat = fs.statSync(EXE_PATH);
		if (!stat.isFile()) throw new Error("not a file");
		let version = "unknown";
		try {
			version = fs.readFileSync(VERSION_PATH, "utf-8").trim() || "unknown";
		} catch {
			// version.txt が無くてもバイナリ配布は可能（version 不明扱い）。
		}
		return {
			available: true,
			filename: EXE_NAME,
			size: stat.size,
			version,
			built_at: stat.mtime.toISOString(),
		};
	} catch {
		return {
			available: false,
			filename: EXE_NAME,
			size: 0,
			version: "unknown",
			built_at: null,
		};
	}
}

export const desktopClientRoutes: RouteDef[] = [
	{
		// 配布バイナリのメタ情報（ダウンロードボタンの有効/無効・サイズ表示に使用）。
		method: "GET",
		path: "/api/desktop/info",
		auth: "user",
		async handler(ctx) {
			sendJson(ctx.res, 200, { success: true, ...readDesktopMeta() });
		},
	},
	{
		// Windows 版 exe のダウンロード（本人認証必須・添付として配信）。
		method: "GET",
		path: "/api/desktop/download",
		auth: "user",
		async handler(ctx) {
			const meta = readDesktopMeta();
			if (!meta.available) {
				return sendJson(ctx.res, 404, {
					success: false,
					message:
						"デスクトップ版のバイナリがまだ配置されていません。デプロイ後にお試しください。",
				});
			}

			const res = ctx.res;
			res.writeHead(200, {
				"Content-Type": "application/vnd.microsoft.portable-executable",
				"Content-Length": meta.size,
				"Content-Disposition": `attachment; filename="${EXE_NAME}"`,
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "no-cache",
			});

			const stream = fs.createReadStream(EXE_PATH);
			stream.on("error", (err) => {
				console.error("デスクトップ版の配信に失敗しました:", err);
				res.destroy();
			});
			res.on("close", () => stream.destroy());
			stream.pipe(res);
		},
	},
];
