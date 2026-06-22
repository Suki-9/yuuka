import { google } from "googleapis";

// googleapis / google-auth-library が内部で使う gaxios 6.x は、Node 実行時でも常に
// node-fetch@2 を選ぶ（hasFetch() が `window.fetch` を見るため Node の native fetch を使わない）。
// その node-fetch@2 は、レスポンスを gzip で受けて gunzip ストリームに通す経路で
// "Premature close"（ERR_STREAM_PREMATURE_CLOSE）となり、Google API 呼び出し
// （OAuth トークン交換・userinfo・カレンダー・Drive バックアップ）が失敗しうる。
//
// 回避策: リクエストの Accept-Encoding を identity に固定し、サーバ側で圧縮させない。
// 圧縮レスポンス自体が来なくなるため gunzip ストリームを一切通らず Premature close を根絶でき、
// かつ本文も正しくデコードされる（実機 userinfo / カレンダーで Content-Encoding が付かないことを確認）。
//
// 【過去の不具合と本実装の理由】
//  - 一時的に `compress:false`（node-fetch の自動解凍を切る）で対処していたが、Google は
//    Accept-Encoding を見て gzip を返し続けるため、node-fetch が未解凍の gzip 生バイトをそのまま
//    本文として渡してしまい、userinfo(メール)・カレンダー・Drive のレスポンスが文字化けして失敗した。
//    トークンエンドポイントは非圧縮のため getToken だけ通り、「連携は完了するのにメール不明・
//    カレンダー取得不可」という症状になっていた。
//  - 最初の identity 実装は小文字 "accept-encoding" を spread しただけで、gaxios が先に入れた
//    大文字 "Accept-Encoding": gzip とプレーンオブジェクト上で別キーとして共存し、結局 gzip が
//    送られて圧縮無効化が効かなかった。よって本実装では大小問わず既存の Accept-Encoding を
//    除去してから identity を一意に設定する。
//
// トランスポート（node-fetch）は維持するため、Drive のストリームアップロード等の挙動は変わらない。
// gaxios インスタンスはプロトタイプ共有のため、request を一度ラップすれば全 Google 呼び出しに効く。

type HeaderBag = Record<string, unknown>;
type GaxiosLikeOpts = { headers?: unknown };
type GaxiosLikeRequest = (opts?: GaxiosLikeOpts) => unknown;

// 除去キーと再設定キーを単一の定数に束ね、casing の取り違えを構造的に防ぐ。
const ACCEPT_ENCODING = "Accept-Encoding";
const IDENTITY = "identity";

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
			// Accept-Encoding を identity に固定し、サーバに圧縮させない（gunzip 経路を断つ）。
			opts.headers = withIdentityEncoding(opts.headers);
			return original.call(this, opts);
		};
		applied = true;
		console.log(
			"🔧 [GoogleHttpFix] Accept-Encoding を identity に固定しました。",
		);
	} catch (err) {
		console.warn(
			"⚠️ [GoogleHttpFix] パッチ適用に失敗しました:",
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * 既存の Accept-Encoding を大小問わず除去し、identity を一意に設定したヘッダを返す。
 * Headers インスタンス / Map / プレーンオブジェクトのいずれにも対応する。
 */
function withIdentityEncoding(src: unknown): HeaderBag {
	const out: HeaderBag = {};
	const drop = ACCEPT_ENCODING.toLowerCase();
	if (src && typeof (src as { forEach?: unknown }).forEach === "function") {
		(src as { forEach: (cb: (v: unknown, k: string) => void) => void }).forEach(
			(v, k) => {
				if (String(k).toLowerCase() !== drop) out[k] = v;
			},
		);
	} else if (src && typeof src === "object") {
		for (const k of Object.keys(src as HeaderBag)) {
			if (k.toLowerCase() !== drop) out[k] = (src as HeaderBag)[k];
		}
	}
	out[ACCEPT_ENCODING] = IDENTITY;
	return out;
}
