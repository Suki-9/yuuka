import crypto from "node:crypto";

/**
 * Webhook ペイロードの HMAC-SHA256 署名を検証する（タイミング安全比較）。
 *
 * - `"sha256=<hex>"`（GitHub 互換）と素の hex の両方を受け付ける。
 * - 署名ヘッダ未指定・hex 形式不正・長さ不一致はいずれも `false`（デフォルト拒否）。
 * - 比較は `crypto.timingSafeEqual` でタイミング攻撃に耐性を持たせる。
 *
 * 復号済みの平文シークレットを受け取る純関数。DB / 暗号鍵に依存しないため
 * 単体テスト可能。呼び出し側（webhookProcessor）でシークレットを復号して渡す。
 */
export function verifyHmacSha256Hex(
	secret: string,
	rawBody: Buffer,
	signatureHeader?: string,
): boolean {
	if (!signatureHeader) return false;

	const provided = signatureHeader.replace(/^sha256=/i, "").trim();
	const expected = crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex");

	try {
		const providedBuf = Buffer.from(provided, "hex");
		const expectedBuf = Buffer.from(expected, "hex");
		if (providedBuf.length !== expectedBuf.length) return false;
		return crypto.timingSafeEqual(providedBuf, expectedBuf);
	} catch {
		return false;
	}
}
