import { getDb } from "./database.js";

// ─── ツール実行実績リポジトリ（2nd Hop: トピック別ツール勝率） ──────────────────
//
// tool_outcomes / topic_tool_stats テーブル（スキーマ定義は db/migrations.ts が唯一の定義元）の
// リポジトリ。ツール実行のたびに実績を1件記録し、トピックに紐づくツールの勝率を
// インクリメンタルに集計する（高勝率ツールの想起 = 2nd Hop に利用）。
// データ分離の原則: 全クエリは user_id + bot_id を WHERE 必須条件とする。

// ─── 型定義 ──────────────────────────────────────────────────────────────────

/** recordToolOutcome の入力 */
export interface ToolOutcomeInput {
	userId: string;
	botId: string;
	guildId?: string | null;
	topicId?: string | null;
	synapseId?: number | null;
	toolName: string;
	argsDigest?: string | null;
	status: "success" | "error";
	latencyMs?: number | null;
}

/** トピック別ツール勝率（2nd Hop 用の集計結果） */
export interface TopicToolStat {
	toolName: string;
	success: number;
	total: number;
	successRate: number;
}

// ─── 記録（INSERT + 統計のインクリメンタル更新） ───────────────────────────────

/**
 * ツール実行実績を1件記録し、topic_id があれば topic_tool_stats をインクリメンタル更新する。
 * tool_outcomes への INSERT と topic_tool_stats の UPSERT を1トランザクションで原子的に処理する。
 */
export function recordToolOutcome(input: ToolOutcomeInput): void {
	const db = getDb();
	const topicId =
		typeof input.topicId === "string" && input.topicId.length > 0
			? input.topicId
			: null;
	// status='success' のときだけ success を 1 加点する（error は total のみ加算）
	const successDelta = input.status === "success" ? 1 : 0;

	const insertOutcome = db.prepare(
		`INSERT INTO tool_outcomes
       (user_id, bot_id, guild_id, topic_id, synapse_id, tool_name, args_digest, status, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);

	// SQLite は SET の右辺を OLD 行の値で評価するため、success_rate は
	// 加算後の値（success + delta, total + 1）を明示的に計算して求める。
	const upsertStat = db.prepare(
		`INSERT INTO topic_tool_stats
       (user_id, bot_id, topic_id, tool_name, success, total, success_rate, last_updated)
     VALUES (?, ?, ?, ?, ?, 1, CAST(? AS REAL) / 1, datetime('now', 'localtime'))
     ON CONFLICT(user_id, bot_id, topic_id, tool_name) DO UPDATE SET
       success = success + ?,
       total = total + 1,
       success_rate = CAST(success + ? AS REAL) / (total + 1),
       last_updated = datetime('now', 'localtime')`,
	);

	const run = db.transaction((args: ToolOutcomeInput) => {
		insertOutcome.run(
			args.userId,
			args.botId,
			args.guildId ?? null,
			topicId,
			args.synapseId ?? null,
			args.toolName,
			args.argsDigest ?? null,
			args.status,
			args.latencyMs ?? null,
		);

		// topic_id がある実行のみツール勝率統計を更新する
		if (topicId !== null) {
			upsertStat.run(
				args.userId,
				args.botId,
				topicId,
				args.toolName,
				successDelta,
				successDelta,
				successDelta,
				successDelta,
			);
		}
	});

	run(input);
}

// ─── 取得（2nd Hop / ベースライン計測） ──────────────────────────────────────

/**
 * トピックに紐づく高勝率ツールを返す（2nd Hop 用。total >= minSamples のみ、success_rate 降順）。
 * サンプル数が少ないツールはノイズになるため minSamples（デフォルト3）で足切りする。
 */
export function getTopicToolStats(
	userId: string,
	botId: string,
	topicId: string,
	minSamples: number = 3,
): TopicToolStat[] {
	const db = getDb();
	return db
		.prepare(
			`SELECT tool_name AS toolName, success, total, success_rate AS successRate
       FROM topic_tool_stats
       WHERE user_id = ? AND bot_id = ? AND topic_id = ? AND total >= ?
       ORDER BY success_rate DESC, total DESC`,
		)
		.all(userId, botId, topicId, minSamples) as TopicToolStat[];
}

/**
 * ベースライン計測用: ツール別の成功/総数集計（toolName 省略時は全ツール）。
 * tool_outcomes を直接集計するため、トピック横断の全実行が対象となる。
 */
export function getToolOutcomeStats(
	userId: string,
	botId: string,
	toolName?: string,
): { toolName: string; success: number; total: number; successRate: number }[] {
	const db = getDb();
	const conditions: string[] = ["user_id = ?", "bot_id = ?"];
	const params: unknown[] = [userId, botId];

	if (toolName !== undefined) {
		conditions.push("tool_name = ?");
		params.push(toolName);
	}

	return db
		.prepare(
			`SELECT
         tool_name AS toolName,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         COUNT(*) AS total,
         CAST(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS successRate
       FROM tool_outcomes
       WHERE ${conditions.join(" AND ")}
       GROUP BY tool_name
       ORDER BY total DESC, toolName ASC`,
		)
		.all(...params) as {
		toolName: string;
		success: number;
		total: number;
		successRate: number;
	}[];
}
