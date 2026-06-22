// ─── プロセスタイムゾーンの既定（JST固定） ───────────────────────────────────
// このアプリは SQLite の datetime('now','localtime') や Date のローカルメソッド
// （getHours / getFullYear など）、new Date("YYYY-MM-DDTHH:mm:ss") のローカル解釈に
// 依存して時刻を扱う（全面的に JST 前提）。TZ 未設定の環境（Docker の Debian slim は
// 既定 UTC）では全時刻が9時間ずれるため、未設定時に限り Asia/Tokyo を既定にする。
//
// ※ 副作用を Date/DB を読む他モジュールより先に効かせるため、エントリポイント
//    （index.ts）の「最初の import」に置くこと。明示指定された TZ は尊重する。
// ※ 名前付きゾーンの解決には tzdata（/usr/share/zoneinfo）が必要。本番イメージは
//    Dockerfile で tzdata を導入済み。
if (!process.env.TZ) {
	process.env.TZ = "Asia/Tokyo";
}
