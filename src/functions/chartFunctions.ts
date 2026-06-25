import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import { EmbedBuilder } from "discord.js";
import { type ChartType, renderChart } from "../services/chartService.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

// ─── グラフ・チャート表示 Function（§3.0.3） ─────────────────────────────────

const declarations: FunctionDeclaration[] = [
	{
		name: "sendChart",
		description:
			"数値データをグラフ画像にして、返信に貼り付けて見せる。\n" +
			"・数字を見て分かりやすくしたい時に使う（例: カテゴリ別の支出内訳、月ごとの収支の動き、タスクの完了率、予算の消化ぐあい、気温の移り変わり、項目の比べっこ）。\n" +
			"・グラフの形は type で選ぶ: 構成比は pie、完了率などは doughnut、項目比較は bar、プログレスバー風は horizontalBar、時系列の推移は line。\n" +
			"・2つのデータを並べて比べたい時は second_values を渡す（例: 収入と支出、最高気温と最低気温）。\n" +
			"・グラフは暗い色合いで描かれ、画像として添付される。1回の返信に貼れるのは1枚まで。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				type: {
					type: SchemaType.STRING,
					description:
						"グラフの形を選ぶ。pie=円グラフ（構成比）, doughnut=ドーナツ（完了率など）, bar=縦棒（項目の比較）, horizontalBar=横棒（予算消化率のプログレスバー風）, line=折れ線（時系列の推移）。",
				},
				title: {
					type: SchemaType.STRING,
					description: "グラフの見出し（例: '6月のカテゴリ別支出'）。",
				},
				labels: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description:
						"各データの名前を並べた配列（例: ['食費','日用品','娯楽'] や ['1月','2月','3月']）。",
				},
				values: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.NUMBER },
					description: "labels と同じ並び順・同じ件数の数値データ。",
				},
				series_label: {
					type: SchemaType.STRING,
					description: "values のデータ系列につける名前（例: '支出'）。省略してよい。",
				},
				second_values: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.NUMBER },
					description:
						"並べて比べるための2本目の数値データ（省略可。例: 収入の系列）。pie と doughnut では使えない。",
				},
				second_label: {
					type: SchemaType.STRING,
					description: "2本目のデータ系列につける名前（例: '収入'）。省略してよい。",
				},
			},
			required: ["type", "title", "labels", "values"],
		},
	},
];

const VALID_TYPES: ChartType[] = [
	"pie",
	"doughnut",
	"bar",
	"horizontalBar",
	"line",
];

const handlers: FunctionModule["handlers"] = {
	async sendChart(
		ctx: ToolContext,
		args: Record<string, unknown>,
	): Promise<string> {
		// リッチ返信が無効の場合はグラフを生成しない（§3.0.5）
		if (!ctx.richReplyEnabled) {
			return JSON.stringify({
				success: false,
				message:
					"ユーザー設定によりリッチ返信（グラフ）は無効です。数値はテキストで簡潔に伝えてください。",
			});
		}

		const type = String(args.type ?? "") as ChartType;
		if (!VALID_TYPES.includes(type)) {
			return JSON.stringify({
				success: false,
				message: `グラフ種別が不正です。pie / doughnut / bar / horizontalBar / line のいずれかを指定してください。`,
			});
		}

		const title = String(args.title ?? "").trim();
		const labels = Array.isArray(args.labels)
			? args.labels.map((l) => String(l))
			: [];
		const values = Array.isArray(args.values)
			? args.values.map((v) => Number(v))
			: [];

		if (labels.length === 0 || values.length === 0) {
			return JSON.stringify({
				success: false,
				message: "labels と values は必須です。",
			});
		}
		if (labels.length !== values.length) {
			return JSON.stringify({
				success: false,
				message: "labels と values の件数が一致していません。",
			});
		}
		if (values.some((v) => !Number.isFinite(v))) {
			return JSON.stringify({
				success: false,
				message: "values に数値でない要素が含まれています。",
			});
		}
		if (labels.length > 30) {
			return JSON.stringify({
				success: false,
				message:
					"データ点が多すぎます（最大30件）。集約してから再度呼び出してください。",
			});
		}

		const datasets: { label?: string; data: number[] }[] = [
			{
				label: args.series_label ? String(args.series_label) : undefined,
				data: values,
			},
		];

		const secondValues = Array.isArray(args.second_values)
			? (args.second_values as unknown[]).map((v) => Number(v))
			: null;
		if (secondValues && secondValues.length > 0) {
			if (type === "pie" || type === "doughnut") {
				return JSON.stringify({
					success: false,
					message: "pie / doughnut では第2系列は使用できません。",
				});
			}
			if (secondValues.length !== labels.length) {
				return JSON.stringify({
					success: false,
					message: "second_values の件数が labels と一致していません。",
				});
			}
			datasets.push({
				label: args.second_label ? String(args.second_label) : "系列2",
				data: secondValues,
			});
		}

		try {
			const png = await renderChart({ type, title, labels, datasets });

			// 添付名はリクエスト内で一意にする（複数添付時の衝突防止）
			const filename = `chart_${ctx.files.length + 1}.png`;
			ctx.files.push({ attachment: png, name: filename });

			const embed = new EmbedBuilder()
				.setTitle(`📊 ${title}`)
				.setColor(0x9b59b6) // タスク・データ系パープル（§3.0.2）
				.setImage(`attachment://${filename}`)
				.setTimestamp();
			ctx.embeds.push(embed);

			return JSON.stringify({
				success: true,
				message: `グラフ「${title}」を生成し、返信に添付しました。本文では要点を簡潔に補足してください（数値の羅列は不要です）。`,
			});
		} catch (err) {
			console.error("[Chart] グラフ生成に失敗しました:", err);
			return JSON.stringify({
				success: false,
				message: `グラフ生成に失敗しました: ${(err as Error).message}。数値はテキストで伝えてください。`,
			});
		}
	},
};

/** グラフ表示 FunctionModule（functions/index.ts でレジストリへマージする） */
export const chartFunctions: FunctionModule = {
	declarations,
	handlers,
};
