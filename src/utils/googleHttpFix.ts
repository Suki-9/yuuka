import { google } from "googleapis";

// googleapis / google-auth-library が内部で使う gaxios 6.x は、Node 実行時でも常に
// node-fetch@2 を選ぶ（hasFetch() が `window.fetch` を見るため Node の native fetch を使わない）。
// その node-fetch@2 は、レスポンスを gzip で受けて gunzip ストリームに通す経路で
// "Premature close"（ERR_STREAM_PREMATURE_CLOSE）となり、Google API 呼び出し
// （OAuth トークン交換・userinfo・カレンダー・Drive バックアップ）が全滅する。
// Node 22/24 いずれでも再現し（Node 固有ではない）、圧縮を使わなければ再現しない。
//
// 回避策: gaxios の request をラップし、node-fetch の `compress` オプションを false にして
// レスポンス圧縮(gzip)を無効化する。これで node-fetch は Accept-Encoding: gzip を付けず、
// gunzip ストリームも通さなくなるため Premature close を回避できる（実機 getToken で検証済み）。
// ※ Accept-Encoding: identity ヘッダ指定では node-fetch が自前の gzip を併記してしまい無効化
//    できなかったため、ヘッダではなく compress オプションで切る。
// トランスポート（node-fetch）は維持するため、Drive のストリームアップロード等の挙動は変わらない。
// gaxios インスタンスはプロトタイプ共有のため、request を一度ラップすれば全 Google 呼び出しに効く。

type GaxiosLikeOpts = { compress?: boolean };
type GaxiosLikeRequest = (opts?: GaxiosLikeOpts) => unknown;

let applied = false;

/**
 * gaxios(node-fetch@2) の "Premature close" を回避するパッチ。起動時に一度だけ呼ぶ。
 * 失敗してもアプリ起動は止めない（Google 機能が不安定になるだけ）。
 */
export function applyGoogleHttpFix(): void {
	if (applied) return;
	try {
		// gaxios は直接依存ではないため、googleapis 経由で生成した transporter からクラスを取得する。
		const probe = new google.auth.OAuth2();
		const instance = (probe as unknown as { transporter: { instance: object } })
			.transporter.instance;
		const proto = Object.getPrototypeOf(instance) as {
			request: GaxiosLikeRequest;
		};
		const original = proto.request;
		if (typeof original !== "function") return;

		proto.request = function patchedRequest(
			this: unknown,
			opts: GaxiosLikeOpts = {},
		) {
			// node-fetch のレスポンス圧縮(gzip)を無効化し、gunzip ストリームの Premature close を断つ。
			opts.compress = false;
			return original.call(this, opts);
		};
		applied = true;
		console.log(
			"🔧 [GoogleHttpFix] gaxios のレスポンス圧縮を無効化しました（node-fetch Premature close 回避）。",
		);
	} catch (err) {
		console.warn(
			"⚠️ [GoogleHttpFix] パッチ適用に失敗しました（Google API が不安定な可能性）:",
			err instanceof Error ? err.message : err,
		);
	}
}
