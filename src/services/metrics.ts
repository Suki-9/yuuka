import { config } from "../config.js";

// ─── 軽量ベースラインメトリクス（architecture §10） ──────────────────────────────
// 依存ゼロ・インメモリのみ。プロセス再起動でリセットされる（恒久ストアは目的外）。

// 各レイテンシ kind ごとに保持する最大標本数（古いものから捨てる）
const MAX_SAMPLES = 1000;

// 定期ログ出力間隔（5分）
const LOG_INTERVAL_MS = 5 * 60 * 1000;

const counters = new Map<string, number>();
const latencies = new Map<string, number[]>();

let logTimer: NodeJS.Timeout | null = null;

/** カウンタを増やす（例: "gemini_calls", "recall_hits", "recall_empty", "tool_calls"）。 */
export function incrMetric(name: string, by = 1): void {
	counters.set(name, (counters.get(name) ?? 0) + by);
}

/** レイテンシ標本を記録する（ms）。kind 例: "response", "assemble", "ttft"。 */
export function recordLatency(kind: string, ms: number): void {
	let arr = latencies.get(kind);
	if (!arr) {
		arr = [];
		latencies.set(kind, arr);
	}
	arr.push(ms);
	// 上限を超えたら最も古い標本を捨てる。
	if (arr.length > MAX_SAMPLES) {
		arr.splice(0, arr.length - MAX_SAMPLES);
	}
}

/** ソート済み配列からパーセンタイル値を取り出す（最近傍）。 */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[idx];
}

/** 現在のスナップショット（カウンタ + 各 kind の count/p50/p95/avg）。 */
export function metricsSnapshot(): Record<string, unknown> {
	const counterSnap: Record<string, number> = {};
	for (const [name, value] of counters) {
		counterSnap[name] = value;
	}

	const latencySnap: Record<
		string,
		{ count: number; p50: number; p95: number; avg: number }
	> = {};
	for (const [kind, arr] of latencies) {
		if (arr.length === 0) {
			latencySnap[kind] = { count: 0, p50: 0, p95: 0, avg: 0 };
			continue;
		}
		const sorted = [...arr].sort((a, b) => a - b);
		const sum = sorted.reduce((acc, v) => acc + v, 0);
		latencySnap[kind] = {
			count: sorted.length,
			p50: percentile(sorted, 50),
			p95: percentile(sorted, 95),
			avg: Math.round(sum / sorted.length),
		};
	}

	return { counters: counterSnap, latency: latencySnap };
}

/** 定期ログ出力を開始（index.ts ライフサイクル用）。config.metricsEnabled が false なら no-op。 */
export function startMetricsLogging(): void {
	if (config.metricsEnabled !== true) return;
	if (logTimer) return;
	logTimer = setInterval(() => {
		console.log(`📊 [Metrics] ${JSON.stringify(metricsSnapshot())}`);
	}, LOG_INTERVAL_MS);
	// プロセス終了を妨げない。
	logTimer.unref();
}

/** 定期ログ出力を停止。 */
export function stopMetricsLogging(): void {
	if (logTimer) {
		clearInterval(logTimer);
		logTimer = null;
	}
}
