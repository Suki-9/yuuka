import fs from "node:fs";
import path from "node:path";

/**
 * パスワードポリシー検証（仕様§5.4.3）
 * - 最低8文字以上
 * - 大文字・小文字・数字・記号のうち2種類以上を含むこと
 * - よく使われるパスワード上位10,000件（common-passwords-10k.txt）との一致を拒否
 */

export interface PasswordValidationResult {
	ok: boolean;
	reason?: string;
}

// ─── よく使われるパスワードリストの読み込み ──────────────────────────────────

/**
 * リスト読み込みの候補パス（process.cwd() からの相対）。
 * ts実行時(src)とビルド後(dist)の両方に対応する。
 */
const COMMON_PASSWORDS_CANDIDATES = [
	"src/assets/common-passwords-10k.txt",
	"dist/assets/common-passwords-10k.txt",
];

let commonPasswords: Set<string> | null = null;

/**
 * よく使われるパスワードリストを一度だけ読み込み、Setにキャッシュする。
 * 比較は小文字正規化で行う（"Password" のような大小文字変形も拒否するため）。
 */
function loadCommonPasswords(): Set<string> {
	if (commonPasswords) return commonPasswords;

	for (const candidate of COMMON_PASSWORDS_CANDIDATES) {
		const filePath = path.resolve(process.cwd(), candidate);
		try {
			if (!fs.existsSync(filePath)) continue;
			const content = fs.readFileSync(filePath, "utf-8");
			const set = new Set<string>();
			for (const line of content.split(/\r?\n/)) {
				const pw = line.trim().toLowerCase();
				if (pw) set.add(pw);
			}
			commonPasswords = set;
			console.log(
				`🔐 よく使われるパスワードリストを読み込みました（${set.size}件: ${candidate}）`,
			);
			return commonPasswords;
		} catch (err) {
			console.error(
				`⚠️ パスワードリストの読み込みに失敗しました（${candidate}）:`,
				err,
			);
		}
	}

	// リストが見つからない場合も登録自体は止めない（文字種・長さチェックのみ適用）
	console.warn(
		"⚠️ common-passwords-10k.txt が見つかりません。一般的パスワードチェックをスキップします。",
	);
	commonPasswords = new Set();
	return commonPasswords;
}

// ─── 検証本体 ────────────────────────────────────────────────────────────────

/**
 * パスワードがポリシーを満たすか検証する。
 * 満たさない場合は ok: false と日本語の理由を返す（UI表示用）。
 */
export function validatePassword(password: string): PasswordValidationResult {
	if (typeof password !== "string" || password.length < 8) {
		return { ok: false, reason: "パスワードは8文字以上にしてください。" };
	}

	// 文字種カウント: 大文字 / 小文字 / 数字 / 記号（英数字以外）のうち2種類以上
	let kinds = 0;
	if (/[A-Z]/.test(password)) kinds++;
	if (/[a-z]/.test(password)) kinds++;
	if (/[0-9]/.test(password)) kinds++;
	if (/[^A-Za-z0-9]/.test(password)) kinds++;
	if (kinds < 2) {
		return {
			ok: false,
			reason: "大文字・小文字・数字・記号のうち2種類以上を含めてください。",
		};
	}

	// よく使われるパスワード上位10,000件との一致を拒否（大小文字を区別しない）
	if (loadCommonPasswords().has(password.toLowerCase())) {
		return {
			ok: false,
			reason:
				"よく使われるパスワードのため使用できません。別のパスワードを設定してください。",
		};
	}

	return { ok: true };
}
