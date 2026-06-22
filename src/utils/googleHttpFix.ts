import { google } from "googleapis";

// googleapis / google-auth-library が内部で使う gaxios 6.x は、Node 実行時でも常に
// node-fetch@2 を選ぶ（hasFetch() が `window.fetch` を見るため Node の native fetch を使わない）。
// その node-fetch@2 は「HTTP agent 未指定 + 圧縮レスポンス」の組み合わせで応答ストリームが
// "Premature close" となり、Google API 呼び出し（OAuth トークン交換・カレンダー・Drive バックアップ）
// が全滅する。Node 22/24 いずれでも再現し（Node 固有ではない）、native fetch では再現しない。
//
// 回避策: gaxios の request をラップしてレスポンス圧縮を無効化する（Accept-Encoding: identity）。
// node-fetch が gunzip ストリームを使わなくなり Premature close を回避できる（実機検証済み）。
// トランスポート（node-fetch）は維持するため、Drive のストリームアップロード等の挙動は変わらない。
// gaxios インスタンスはプロトタイプ共有のため、request を一度ラップすれば全 Google 呼び出しに効く。

type HeaderBag = Record<string, string>;
type GaxiosLikeRequest = (opts?: { headers?: HeaderBag }) => unknown;

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
			opts: { headers?: HeaderBag } = {},
		) {
			// 既存指定は尊重しつつ、Accept-Encoding を最後に置いて圧縮無効を確実に効かせる。
			opts.headers = { ...(opts.headers ?? {}), "accept-encoding": "identity" };
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
