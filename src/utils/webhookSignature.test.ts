import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyHmacSha256Hex } from "./webhookSignature.js";

const secret = "test-secret";
const body = Buffer.from('{"event":"ping"}', "utf-8");

function sign(s: string, b: Buffer): string {
	return crypto.createHmac("sha256", s).update(b).digest("hex");
}

describe("verifyHmacSha256Hex", () => {
	it("正しい hex 署名を受理する", () => {
		expect(verifyHmacSha256Hex(secret, body, sign(secret, body))).toBe(true);
	});

	it("GitHub 互換の sha256= 接頭辞を受理する (大文字も可)", () => {
		const sig = sign(secret, body);
		expect(verifyHmacSha256Hex(secret, body, `sha256=${sig}`)).toBe(true);
		expect(verifyHmacSha256Hex(secret, body, `SHA256=${sig}`)).toBe(true);
	});

	it("接頭辞除去後の末尾空白を許容する", () => {
		expect(
			verifyHmacSha256Hex(secret, body, `sha256=${sign(secret, body)}  `),
		).toBe(true);
	});

	it("誤ったシークレットを拒否する", () => {
		expect(verifyHmacSha256Hex(secret, body, sign("wrong-secret", body))).toBe(
			false,
		);
	});

	it("改ざんされたボディを拒否する", () => {
		const tampered = Buffer.from('{"event":"pong"}', "utf-8");
		expect(verifyHmacSha256Hex(secret, tampered, sign(secret, body))).toBe(
			false,
		);
	});

	it("署名ヘッダ未指定・空文字は拒否する (デフォルト拒否)", () => {
		expect(verifyHmacSha256Hex(secret, body, undefined)).toBe(false);
		expect(verifyHmacSha256Hex(secret, body, "")).toBe(false);
	});

	it("hex でない/長さ不一致の署名を拒否する", () => {
		expect(verifyHmacSha256Hex(secret, body, "not-a-hex-string")).toBe(false);
		expect(verifyHmacSha256Hex(secret, body, "abcd")).toBe(false);
	});
});
