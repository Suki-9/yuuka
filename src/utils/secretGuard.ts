// ─── 秘匿値ガード（値の「形状」ベースの検出。§0.3 / §9.3 不変条件の補強） ───────────
//
// 既存の秘匿マスクはキー名（password / token 等）に基づくため、
//   ・自由入力フィールド（browserInteractiveType の text 等）にタイプされた認証情報
//   ・トリガ語を伴わずに貼り付けられた高エントロピーなトークン（JWT・APIキー・PEM 等）
// を取りこぼす。本モジュールは「値そのものの形状」から秘匿値らしさを判定し、
// ログ用ダイジェスト・シナプス抽出の双方で取りこぼしを塞ぐ（多層防御）。
//
// 完全な検出は不可能（人間が決めた低エントロピーなパスワード等）だが、
// 機械生成トークン・鍵・JWT といった「明確に秘匿」な形状を確実に弾くことを目的とする。

/** 既知の秘匿トークン接頭辞（部分一致で判定） */
const SECRET_PREFIXES = [
	"sk-", // OpenAI 等
	"rk_",
	"ghp_",
	"gho_",
	"ghu_",
	"ghs_",
	"ghr_",
	"github_pat_", // GitHub PAT
	"xoxb-",
	"xoxp-",
	"xoxa-",
	"xoxr-",
	"xoxs-", // Slack
	"AKIA",
	"ASIA", // AWS アクセスキー
	"AIza", // Google API キー
	"ya29.", // Google OAuth アクセストークン
	"-----BEGIN", // PEM（秘密鍵・証明書）
	"AccountKey=", // Azure 接続文字列
];

/** JWT（base64url の3セグメント。先頭は必ず eyJ＝{"... の base64url） */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/;

/** 秘匿値らしい連続トークン（区切り文字を含まない 12 文字以上の塊） */
const TOKEN_RUN_RE = /[A-Za-z0-9_\-+/=.]{12,}/g;

/** 文字あたりのシャノンエントロピー（bit）。ランダム塊ほど高い。 */
function shannonEntropyBits(s: string): number {
	if (s.length === 0) return 0;
	const freq = new Map<string, number>();
	for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
	let bits = 0;
	for (const count of freq.values()) {
		const p = count / s.length;
		bits -= p * Math.log2(p);
	}
	return bits;
}

/**
 * 1トークン（空白等で区切られた塊）が秘匿値らしい形状かを判定する。
 * 判定基準: 既知接頭辞 / JWT / 高エントロピーな長い英数字塊。
 */
export function looksLikeSecretValue(token: string): boolean {
	if (!token) return false;
	const t = token.trim();
	if (t.length < 8) return false;

	for (const prefix of SECRET_PREFIXES) {
		if (t.includes(prefix)) return true;
	}
	if (JWT_RE.test(t)) return true;

	// 区切りを含まない長い英数字塊で、文字クラスが混在し、エントロピーが高いもの。
	const runs = t.match(TOKEN_RUN_RE);
	if (runs) {
		for (const run of runs) {
			const classes =
				(/[a-z]/.test(run) ? 1 : 0) +
				(/[A-Z]/.test(run) ? 1 : 0) +
				(/[0-9]/.test(run) ? 1 : 0);
			const entropy = shannonEntropyBits(run);
			// 24文字以上・2クラス以上・高エントロピー → 機械生成トークンとみなす
			if (run.length >= 24 && classes >= 2 && entropy >= 3.2) return true;
			// 40文字以上の非常に長い塊は1クラスでも秘匿扱い（hex ダンプ等）
			if (run.length >= 40 && entropy >= 3.0) return true;
		}
	}
	return false;
}

/** テキスト中に秘匿値らしいトークンが1つでも含まれるか。 */
export function containsSecretValue(text: string): boolean {
	if (!text) return false;
	// PEM など改行を含む鍵ブロックも拾えるよう、空白・引用符・カンマ等で素朴に分割。
	for (const tok of text.split(/[\s"'`,;<>(){}[\]]+/)) {
		if (looksLikeSecretValue(tok)) return true;
	}
	return false;
}

/**
 * テキスト中の秘匿値らしいトークンを伏字へ置換する（ログ・ダイジェスト用）。
 * 区切り文字を含まない 12 文字以上の塊を走査し、秘匿形状のものだけを置換する。
 */
export function redactSecretsInText(text: string): string {
	if (!text) return text;
	return text.replace(TOKEN_RUN_RE, (tok) =>
		looksLikeSecretValue(tok) ? "(秘匿値)" : tok,
	);
}
