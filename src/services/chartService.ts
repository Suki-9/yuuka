import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { Chart } from "chart.js/auto";

// ─── グラフ・チャート画像生成（§3.0.3） ──────────────────────────────────────
// chart.js + @napi-rs/canvas でPNGを生成する。
// Discordのダークモードに合わせたテーマ（背景 #2B2D31）で描画する。

export type ChartType = "pie" | "doughnut" | "bar" | "horizontalBar" | "line";

export interface ChartDataset {
  label?: string;
  data: number[];
  color?: string;
}

export interface RenderChartOptions {
  type: ChartType;
  title?: string;
  labels: string[];
  datasets: ChartDataset[];
  width?: number;
  height?: number;
}

/** Discordダークモード調のデフォルトカラーパレット */
const PALETTE = [
  "#5865F2", // ブルー（通常情報）
  "#57F287", // グリーン（成功）
  "#FEE75C", // イエロー（警告）
  "#ED4245", // レッド（エラー）
  "#00B0F4", // スカイブルー（天気）
  "#F1C40F", // ゴールド（家計）
  "#9B59B6", // パープル（タスク）
  "#EB459E", // ピンク
];

const BG_COLOR = "#2B2D31";
const TEXT_COLOR = "#DCDDDE";
const GRID_COLOR = "#3F4147";

// 日本語フォントの検出（@napi-rs/canvas はシステムフォントを自動ロードする。
// CJK対応ファミリが見つかればChart.jsのデフォルトに設定。無ければ豆腐化は許容）
let fontConfigured = false;
function ensureFontConfigured(): void {
  if (fontConfigured) return;
  fontConfigured = true;
  try {
    const families = GlobalFonts.families.map((f) => f.family);
    const cjkCandidates = [
      "Noto Sans CJK JP",
      "Noto Sans JP",
      "IPAGothic",
      "IPAexGothic",
      "TakaoGothic",
      "VL Gothic",
      "M+ 1c",
      "Source Han Sans JP",
    ];
    const found = cjkCandidates.find((c) => families.some((f) => f === c || f.startsWith(c)));
    if (found) {
      Chart.defaults.font.family = `'${found}', sans-serif`;
      console.log(`[Chart] 日本語フォントを使用します: ${found}`);
    } else {
      // フォールバック: CJKを含みそうなファミリ名を部分一致で探す
      const fuzzy = families.find((f) => /CJK|JP|Gothic|Mincho|明朝|ゴシック/i.test(f));
      if (fuzzy) {
        Chart.defaults.font.family = `'${fuzzy}', sans-serif`;
        console.log(`[Chart] 日本語フォント候補を使用します: ${fuzzy}`);
      } else {
        console.warn("[Chart] 日本語フォントが見つかりません。日本語ラベルが正しく描画されない可能性があります。");
      }
    }
  } catch (err) {
    console.warn("[Chart] フォント設定の初期化に失敗しました:", err);
  }
}

/** 透明度付きHEXカラーを生成する（line塗りつぶし用） */
function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${a}`;
}

/**
 * チャートをPNGバイナリとして描画する
 */
export async function renderChart(opts: RenderChartOptions): Promise<Buffer> {
  ensureFontConfigured();

  const width = opts.width ?? 800;
  const height = opts.height ?? 450;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const isCircular = opts.type === "pie" || opts.type === "doughnut";
  const chartJsType = opts.type === "horizontalBar" ? "bar" : opts.type;

  const datasets = opts.datasets.map((ds, i) => {
    const baseColor = ds.color ?? PALETTE[i % PALETTE.length];
    if (isCircular) {
      // 円系: データ点ごとにパレット色を割り当てる
      return {
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.data.map((_, j) => PALETTE[j % PALETTE.length]),
        borderColor: BG_COLOR,
        borderWidth: 2,
      };
    }
    if (opts.type === "line") {
      return {
        label: ds.label,
        data: ds.data,
        borderColor: baseColor,
        backgroundColor: withAlpha(baseColor, 0.25),
        fill: true,
        tension: 0.3,
        pointBackgroundColor: baseColor,
        pointRadius: 4,
        borderWidth: 2,
      };
    }
    // bar / horizontalBar
    return {
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.color
        ? ds.data.map(() => baseColor)
        : ds.data.map((_, j) => (opts.datasets.length === 1 ? PALETTE[j % PALETTE.length] : baseColor)),
      borderRadius: 6,
      borderWidth: 0,
    };
  });

  const showLegend = isCircular || opts.datasets.some((d) => !!d.label);

  // 背景塗りつぶしプラグイン（Canvasのデフォルトは透明のため）
  const backgroundPlugin = {
    id: "yuukaBackground",
    beforeDraw(chart: Chart) {
      const c = chart.ctx;
      c.save();
      c.globalCompositeOperation = "destination-over";
      c.fillStyle = BG_COLOR;
      c.fillRect(0, 0, chart.width, chart.height);
      c.restore();
    },
  };

  const chart = new Chart(ctx as unknown as CanvasRenderingContext2D, {
    type: chartJsType,
    data: {
      labels: opts.labels,
      datasets,
    },
    options: {
      responsive: false,
      animation: false,
      ...(opts.type === "horizontalBar" ? { indexAxis: "y" as const } : {}),
      plugins: {
        title: opts.title
          ? {
              display: true,
              text: opts.title,
              color: "#FFFFFF",
              font: { size: 18, weight: "bold" },
              padding: { top: 12, bottom: 16 },
            }
          : { display: false },
        legend: {
          display: showLegend,
          position: isCircular ? ("right" as const) : ("top" as const),
          labels: { color: TEXT_COLOR, font: { size: 13 }, padding: 14 },
        },
      },
      ...(isCircular
        ? {}
        : {
            scales: {
              x: {
                ticks: { color: TEXT_COLOR, font: { size: 12 } },
                grid: { color: GRID_COLOR },
              },
              y: {
                ticks: { color: TEXT_COLOR, font: { size: 12 } },
                grid: { color: GRID_COLOR },
                beginAtZero: true,
              },
            },
          }),
    },
    plugins: [backgroundPlugin],
  });

  try {
    chart.draw();
    return canvas.toBuffer("image/png");
  } finally {
    chart.destroy();
  }
}
