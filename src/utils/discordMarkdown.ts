// ─── Discord 非対応 Markdown の機械的変換 ───────────────────────────────────
// Discord は CommonMark 等の標準Markdownと完全互換ではなく、一部記法が
// レンダリングされない。送信前に本モジュールで Discord 互換の代替表現へ
// 変換する（変換ガイドライン §1〜§6 に準拠）。
//
// 重要な不変条件:
//   - コードブロック(``` ```)・インラインコード(` `)の内部は一切変換しない。
//   - 変換は「分割(splitMessage)前の全文」に対して行うこと。チャンク境界で
//     コードフェンスが割れた状態で適用するとコード判定が壊れるため。

export interface DiscordMarkdownOptions {
	/** §1 タスクリスト `- [ ]` / `- [x]` → 絵文字プレフィックス */
	taskList?: boolean;
	/** §2 ハイライト `==text==` → 太字 */
	highlight?: boolean;
	/** §2 簡易インラインHTML → Discord記法 */
	html?: boolean;
	/** §3 数式 `$$...$$` → コードブロック、`$...$`（数式記号を含む場合）→ インラインコード */
	math?: boolean;
	/** §4 脚注 `[^1]` / `[^1]: ...` → `※1` 形式 */
	footnotes?: boolean;
	/** §6 テーブル `|---|` → 等幅フォントのアスキー表（コードブロック） */
	tables?: boolean;
}

const DEFAULT_OPTIONS: Required<DiscordMarkdownOptions> = {
	taskList: true,
	highlight: true,
	html: true,
	math: true,
	footnotes: true,
	tables: true,
};

/**
 * 非対応Markdownを Discord 互換の代替表現へ変換する。
 * コードブロック・インラインコードの内部は保護し、変換対象から除外する。
 */
export function toDiscordMarkdown(
	input: string,
	options: DiscordMarkdownOptions = {},
): string {
	if (!input) return input;
	const opts = { ...DEFAULT_OPTIONS, ...options };

	// フェンスドコードブロックを保護しつつ、それ以外の区間のみ変換する
	return splitKeepingDelimiter(input, /```[\s\S]*?```/g)
		.map((seg) => (seg.isMatch ? seg.text : transformPlain(seg.text, opts)))
		.join("");
}

// ─── 区間分割ヘルパ ─────────────────────────────────────────────────────────
// 正規表現にマッチした部分を「保護対象」として、非マッチ部分と区別して返す。

interface Segment {
	text: string;
	isMatch: boolean;
}

function splitKeepingDelimiter(input: string, re: RegExp): Segment[] {
	const segments: Segment[] = [];
	let lastIndex = 0;
	for (const m of input.matchAll(re)) {
		const start = m.index ?? 0;
		if (start > lastIndex)
			segments.push({ text: input.slice(lastIndex, start), isMatch: false });
		segments.push({ text: m[0], isMatch: true });
		lastIndex = start + m[0].length;
	}
	if (lastIndex < input.length)
		segments.push({ text: input.slice(lastIndex), isMatch: false });
	return segments;
}

// ─── プレーン区間（コードブロック外）の変換 ─────────────────────────────────

function transformPlain(
	text: string,
	opts: Required<DiscordMarkdownOptions>,
): string {
	// 行構造を保つ変換（行頭パターン）。インラインコードは行頭には来ないため安全。
	let work = text
		.split("\n")
		.map((line) => {
			let l = line;
			if (opts.taskList) l = convertTaskListLine(l);
			if (opts.footnotes) l = convertFootnoteDefLine(l);
			return l;
		})
		.join("\n");

	// テーブルは複数行ブロックなので、まだコードフェンス化されていない段階で変換する
	if (opts.tables) work = convertTables(work);

	// インライン変換はインラインコードを保護して適用する
	work = applyInline(work, opts);
	return work;
}

/** インラインコード(` `)を保護しつつ、インライン系の置換を適用する */
function applyInline(
	text: string,
	opts: Required<DiscordMarkdownOptions>,
): string {
	return splitKeepingDelimiter(text, /`[^`\n]+`/g)
		.map((seg) => {
			if (seg.isMatch) return seg.text;
			let s = seg.text;
			if (opts.math) s = convertMath(s);
			if (opts.highlight) s = convertHighlight(s);
			if (opts.html) s = convertInlineHtml(s);
			if (opts.footnotes) s = convertFootnoteRefs(s);
			return s;
		})
		.join("");
}

// §1 タスクリスト ------------------------------------------------------------

function convertTaskListLine(line: string): string {
	return line.replace(
		/^(\s*)[-*+]\s+\[([ xX/-])\]\s+/,
		(_m, indent: string, mark: string) => {
			let box: string;
			if (mark === " ") box = "⬜";
			else if (mark === "-" || mark === "/")
				box = "🔄"; // 進行中（拡張記法）
			else box = "✅";
			return `${indent}${box} `;
		},
	);
}

// §4 脚注 --------------------------------------------------------------------

function convertFootnoteDefLine(line: string): string {
	// 定義行 `[^id]: text` → `[※id] text`
	return line.replace(
		/^(\s*)\[\^([^\]]+)\]:\s*/,
		(_m, indent: string, id: string) => `${indent}[※${id}] `,
	);
}

function convertFootnoteRefs(text: string): string {
	// 参照 `[^id]` → `[※id]`（定義行は変換済みで `[^` を含まない）
	return text.replace(/\[\^([^\]]+)\]/g, (_m, id: string) => `[※${id}]`);
}

// §2 ハイライト / 簡易HTML ---------------------------------------------------

function convertHighlight(text: string): string {
	// ==text== → **text**（Discordにハイライトが無いため太字で代替）
	return text.replace(/==([^=\n]+)==/g, (_m, t: string) => `**${t}**`);
}

function convertInlineHtml(text: string): string {
	return text
		.replace(
			/<\s*(b|strong)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi,
			(_m, _tag, inner: string) => `**${inner}**`,
		)
		.replace(
			/<\s*(i|em)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi,
			(_m, _tag, inner: string) => `*${inner}*`,
		)
		.replace(
			/<\s*u\s*>([\s\S]*?)<\s*\/\s*u\s*>/gi,
			(_m, inner: string) => `__${inner}__`,
		)
		.replace(
			/<\s*(mark|span)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi,
			(_m, _tag, inner: string) => `**${inner}**`,
		);
}

// §3 数式 --------------------------------------------------------------------

// LaTeX/数式記号らしさの判定（通貨 `$100` などの誤変換を避ける）
const MATH_HINT = /[\\^_{}=∑∫√≈≠≤≥×÷±∞αβγδθλμπσφω]|\\[a-zA-Z]+/;

function convertMath(text: string): string {
	// ブロック数式 $$...$$ → コードブロック（先に処理）
	let out = text.replace(
		/\$\$([\s\S]+?)\$\$/g,
		(_m, body: string) => `\n\`\`\`\n${body.trim()}\n\`\`\`\n`,
	);
	// インライン数式 $...$ → インラインコード（数式記号を含むものだけ。通貨は対象外）
	out = out.replace(/\$([^$\n]+?)\$/g, (m: string, body: string) =>
		MATH_HINT.test(body) ? `\`${body.trim()}\`` : m,
	);
	return out;
}

// §6 テーブル ----------------------------------------------------------------

function isTableSeparator(line: string | undefined): boolean {
	if (line === undefined) return false;
	const cells = splitTableRow(line);
	if (cells.length === 0 || (cells.length === 1 && cells[0] === ""))
		return false;
	return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|").map((c) => c.trim());
}

function convertTables(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const header = lines[i];
		if (header.includes("|") && isTableSeparator(lines[i + 1])) {
			const headerCells = splitTableRow(header);
			i += 2; // ヘッダ行と区切り行をスキップ
			const rows: string[][] = [];
			while (
				i < lines.length &&
				lines[i].includes("|") &&
				lines[i].trim() !== ""
			) {
				rows.push(splitTableRow(lines[i]));
				i++;
			}
			result.push(renderAsciiTable(headerCells, rows));
			continue;
		}
		result.push(header);
		i++;
	}
	return result.join("\n");
}

function renderAsciiTable(header: string[], rows: string[][]): string {
	const colCount = Math.max(header.length, ...rows.map((r) => r.length));
	const widths: number[] = [];
	for (let c = 0; c < colCount; c++) {
		const cells = [header[c] ?? "", ...rows.map((r) => r[c] ?? "")];
		widths[c] = Math.max(1, ...cells.map((cell) => displayWidth(cell)));
	}

	const renderRow = (cells: string[]) =>
		Array.from({ length: colCount }, (_v, c) =>
			padCell(cells[c] ?? "", widths[c]),
		).join(" | ");
	const separator = widths.map((w) => "-".repeat(w)).join("-|-");

	const body = [renderRow(header), separator, ...rows.map(renderRow)].join(
		"\n",
	);
	return `\`\`\`\n${body}\n\`\`\``;
}

// 全角文字を2幅として簡易計算（等幅表示の桁ずれを軽減）
const FULLWIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

function displayWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		w += FULLWIDTH.test(ch) ? 2 : 1;
	}
	return w;
}

function padCell(s: string, width: number): string {
	const pad = width - displayWidth(s);
	return pad > 0 ? s + " ".repeat(pad) : s;
}
