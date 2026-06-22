// ─── 日時ヘルパー（DB格納形式 'YYYY-MM-DD HH:MM:SS' ローカルタイム） ──────────
// DBの日時カラムは既存スタイル（datetime('now','localtime')）に合わせた
// ローカルタイムのテキストで統一する。変換は必ず本モジュールを経由すること。

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * ISO 8601 / 'YYYY-MM-DD HH:MM:SS' / Date を DB格納形式へ変換する。
 * 解釈できない場合は例外を投げる。
 */
export function toDbDateTime(input: string | Date): string {
	let date: Date;
	if (input instanceof Date) {
		date = input;
	} else {
		const v = input.trim();
		if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
			// 日付のみは「ローカルの 0時」として解釈する（new Date('YYYY-MM-DD') はUTC解釈になるため）
			date = new Date(`${v}T00:00:00`);
		} else {
			// 'YYYY-MM-DD HH:MM:SS' 形式は ISO 形式へ寄せてパース（ローカルタイム解釈）
			date = new Date(v.replace(" ", "T"));
		}
	}
	if (Number.isNaN(date.getTime())) {
		throw new Error(`日時として解釈できません: ${String(input)}`);
	}
	return (
		`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
		`${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
	);
}

/** DB格納形式（ローカルタイム）を Date へ変換する */
export function parseDbDateTime(value: string): Date {
	return new Date(value.trim().replace(" ", "T"));
}
