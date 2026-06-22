import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { config } from "../config.js";

// ─── 公開型（FROZEN: 他コードがこの形に依存する） ──────────────────────────────

export interface SynapseScope {
	userId: string;
	botId: string;
	guildId?: string | null;
}

export interface RecalledSynapse {
	id: number;
	content: string;
	topicId: string | null;
	score: number;
}

export interface RecallResult {
	synapses: RecalledSynapse[];
	tools: unknown[];
}

// ─── IPC プロトコル（FROZEN: Rust デーモンが実装、こちらは呼ぶだけ） ──────────────
// 要求行:  {"id":<number>,"command":<string>, ...fields}\n
// 応答行:  {"id":<number>,"ok":<boolean>,"result":<object|null>,"error":<string|null>}\n

interface SynapseDaemonResponse {
	id: number;
	ok: boolean;
	result?: unknown;
	error?: string | null;
}

interface PendingSynapseRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

// Rust 側へ送る scope は snake_case（guild_id は無い時 null）
interface WireScope {
	user_id: string;
	bot_id: string;
	guild_id: string | null;
}

function toWireScope(scope: SynapseScope): WireScope {
	return {
		user_id: scope.userId,
		bot_id: scope.botId,
		guild_id: scope.guildId ?? null,
	};
}

// ─── バイナリパス候補（getCrawlerBinPath を踏襲） ───────────────────────────────

const SYNAPSE_BIN_PATHS = [
	path.resolve(process.cwd(), "src/rust_synapse/target/release/yuuka-synapse"),
	path.resolve(process.cwd(), "src/rust_synapse/target/debug/yuuka-synapse"),
	path.resolve(process.cwd(), "dist/bin/yuuka-synapse"),
];

function getSynapseBinPath(): string | null {
	for (const binPath of SYNAPSE_BIN_PATHS) {
		if (fs.existsSync(binPath)) {
			return binPath;
		}
	}
	return null;
}

// ─── Synapse Daemon（常駐プロセス、crawler の grain を踏襲） ──────────────────────

class SynapseDaemon {
	private proc: ChildProcess | null = null;
	private pending = new Map<number, PendingSynapseRequest>();
	private nextId = 0;
	private startingPromise: Promise<void> | null = null;

	constructor(
		private binPath: string,
		private dbPath: string,
	) {}

	private start(): Promise<void> {
		if (this.proc) return Promise.resolve();
		if (this.startingPromise) return this.startingPromise;

		this.startingPromise = (async () => {
			const proc = spawn(this.binPath, ["daemon", "--db", this.dbPath], {
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env },
			});

			const rl = createInterface({ input: proc.stdout! });
			rl.on("line", (line: string) => {
				try {
					const res: SynapseDaemonResponse = JSON.parse(line);
					const req = this.pending.get(res.id);
					if (!req) return;
					clearTimeout(req.timer);
					this.pending.delete(res.id);
					if (res.ok) {
						req.resolve(res.result ?? null);
					} else {
						req.reject(new Error(res.error ?? "Unknown daemon error"));
					}
				} catch {
					/* malformed line は無視 */
				}
			});

			proc.stderr?.on("data", (data: Buffer) => {
				process.stderr.write(`[Synapse Daemon] ${data}`);
			});

			// 'error' リスナーが無いと spawn 失敗（権限等）でプロセスごとクラッシュする
			proc.on("error", (err) => {
				console.error("[Synapse Daemon] プロセスエラー:", err);
				rl.close();
				this.proc = null;
				this.startingPromise = null;
				this.failAllPending(
					new Error(`Synapse daemon process error: ${err.message}`),
				);
			});

			// デーモン死亡後の書き込みで EPIPE が emit されてもクラッシュさせない
			proc.stdin?.on("error", (err) => {
				console.error("[Synapse Daemon] stdin への書き込みエラー:", err);
			});

			proc.on("exit", (code) => {
				console.error(
					`[Synapse Daemon] Process exited (code: ${code}), 次のリクエスト時に再起動します`,
				);
				rl.close();
				this.proc = null;
				this.startingPromise = null;
				this.failAllPending(new Error("Synapse daemon exited unexpectedly"));
			});

			this.proc = proc;
			this.startingPromise = null;
		})();

		return this.startingPromise;
	}

	private failAllPending(err: Error): void {
		for (const [, req] of this.pending) {
			clearTimeout(req.timer);
			req.reject(err);
		}
		this.pending.clear();
	}

	/** start() を明示的に呼ぶウォームスタート用フック */
	async warm(): Promise<void> {
		await this.start();
	}

	async send(
		command: string,
		fields: Record<string, unknown>,
		timeoutMs: number,
	): Promise<unknown> {
		await this.start();
		// start() 直後でもデーモンが即死していることがある（exit ハンドラで proc=null）
		const proc = this.proc;
		if (!proc?.stdin || !proc.stdin.writable) {
			throw new Error("Synapse daemon is not running");
		}
		const id = ++this.nextId;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Synapse daemon timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			// 封筒 id/command は常に勝たせる（fields 内の同名キーに上書きされないよう末尾に置く）。
			// シナプス ID は別キー sid で運ぶ規約（index/forget）。
			proc.stdin!.write(
				JSON.stringify({ ...fields, id, command }) + "\n",
				(writeErr) => {
					if (writeErr && this.pending.has(id)) {
						clearTimeout(timer);
						this.pending.delete(id);
						reject(
							new Error(`Synapse daemon write failed: ${writeErr.message}`),
						);
					}
				},
			);
		});
	}

	shutdown(): void {
		this.proc?.kill();
		this.proc = null;
	}
}

let _synapseDaemon: SynapseDaemon | null = null;

process.on("exit", () => {
	_synapseDaemon?.shutdown();
});

/**
 * デーモンを取得（必要なら遅延生成）。
 * 機能フラグ OFF・バイナリ不在時は null（呼び出し側はデグレード）。
 */
function getDaemon(): SynapseDaemon | null {
	if (!isSynapseEngineEnabled()) return null;
	if (_synapseDaemon) return _synapseDaemon;
	const binPath = getSynapseBinPath();
	if (!binPath) {
		console.warn(
			"⚠️ [Synapse] yuuka-synapse バイナリが見つかりません。エンジンを無効化します。",
		);
		return null;
	}
	_synapseDaemon = new SynapseDaemon(binPath, config.dbPath);
	return _synapseDaemon;
}

// ─── 公開 API（FROZEN）。すべて呼び出し側へ throw しない ─────────────────────────

/** 機能フラグ（config.synapseEngineEnabled）。OFF のとき全 API は no-op で null を返す。 */
export function isSynapseEngineEnabled(): boolean {
	return config.synapseEngineEnabled === true;
}

/** 起動時のウォームスタート（任意）。index.ts のライフサイクルから呼ぶ。失敗しても投げない。 */
export async function startSynapseEngine(): Promise<void> {
	try {
		const daemon = getDaemon();
		if (!daemon) return;
		await daemon.warm();
		console.log("🧠 [Synapse] エンジンをウォームスタートしました。");
	} catch (err) {
		console.warn(
			"⚠️ [Synapse] エンジンのウォームスタートに失敗しました（デグレード継続）:",
			err instanceof Error ? err.message : err,
		);
	}
}

/** graceful shutdown 用。 */
export function stopSynapseEngine(): void {
	try {
		_synapseDaemon?.shutdown();
		_synapseDaemon = null;
	} catch {
		/* shutdown 失敗は無視 */
	}
}

/** L2 連想（1st Hop）。エンジン無効/未起動/タイムアウト時は null（呼び出し側は現行挙動へデグレード）。 */
export async function assembleRecall(
	scope: SynapseScope,
	query: string,
	k = 8,
	/**
	 * 時刻文脈の再ランキング指定（任意）。意味KNN後にコサインスコアへ補正をかける。
	 * timeWeight=0（既定）または未指定のとき Rust 側は補正しない＝純粋な意味KNN。
	 * nowTod=現在の時間帯(0-23) / nowDow=現在の曜日(0=日〜6=土)。
	 */
	timeCtx?: { nowTod: number; nowDow: number; timeWeight: number },
): Promise<RecallResult | null> {
	const daemon = getDaemon();
	if (!daemon) return null;
	try {
		// assemble は短いタイムアウト（既定 2500ms）でユーザー応答を遅延させない
		const result = (await daemon.send(
			"assemble",
			{
				scope: toWireScope(scope),
				query,
				k,
				// 重みが正のときのみ時刻文脈を送る（既定は送らず Rust 側を素通り）。
				...(timeCtx && timeCtx.timeWeight > 0
					? {
							now_tod: timeCtx.nowTod,
							now_dow: timeCtx.nowDow,
							time_weight: timeCtx.timeWeight,
						}
					: {}),
			},
			2500,
		)) as {
			synapses?: Array<{
				id: number;
				content: string;
				topic_id: string | null;
				score: number;
			}>;
			tools?: unknown[];
		} | null;

		if (!result) return null;
		const synapses: RecalledSynapse[] = (result.synapses ?? []).map((s) => ({
			id: s.id,
			content: s.content,
			topicId: s.topic_id ?? null,
			score: s.score,
		}));
		return { synapses, tools: result.tools ?? [] };
	} catch (err) {
		console.warn(
			"⚠️ [Synapse] assemble に失敗しました（現行挙動へデグレード）:",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/** シナプスを RAM 索引へ追加し、永続化用の埋め込み(base64)とモデル世代を返す。失敗時 null。 */
export async function indexSynapse(
	id: number,
	scope: SynapseScope,
	topicId: string | null,
	content: string,
	/** 形成時の時刻文脈（再ランキング専用）。未知なら null。 */
	timeCtx?: { ctxTod: number | null; ctxDow: number | null },
): Promise<{ embeddingB64: string; modelVersion: string; dim: number } | null> {
	const daemon = getDaemon();
	if (!daemon) return null;
	try {
		const result = (await daemon.send(
			"index",
			{
				sid: id,
				scope: toWireScope(scope),
				topic_id: topicId,
				content,
				ctx_tod: timeCtx?.ctxTod ?? null,
				ctx_dow: timeCtx?.ctxDow ?? null,
			},
			8000,
		)) as {
			embedding_b64?: string;
			model_version?: string;
			dim?: number;
		} | null;

		if (
			!result ||
			typeof result.embedding_b64 !== "string" ||
			typeof result.model_version !== "string" ||
			typeof result.dim !== "number"
		) {
			return null;
		}
		return {
			embeddingB64: result.embedding_b64,
			modelVersion: result.model_version,
			dim: result.dim,
		};
	} catch (err) {
		console.warn(
			"⚠️ [Synapse] index に失敗しました（埋め込みなしで永続化を継続）:",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/** RAM 索引から削除（シナプス削除時）。失敗は無視。 */
export async function forgetSynapse(id: number): Promise<void> {
	const daemon = getDaemon();
	if (!daemon) return;
	try {
		await daemon.send("forget", { sid: id }, 8000);
	} catch (err) {
		console.warn(
			"⚠️ [Synapse] forget に失敗しました（無視）:",
			err instanceof Error ? err.message : err,
		);
	}
}

/** RAM 索引を SQLite から再構築する。失敗時 null。 */
export async function reindexSynapses(): Promise<{ total: number } | null> {
	const daemon = getDaemon();
	if (!daemon) return null;
	try {
		const result = (await daemon.send("reindex", {}, 8000)) as {
			total?: number;
		} | null;
		if (!result || typeof result.total !== "number") return null;
		return { total: result.total };
	} catch (err) {
		console.warn(
			"⚠️ [Synapse] reindex に失敗しました:",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/** ヘルスチェック。失敗時 null。 */
export async function synapseHealth(): Promise<{
	modelVersion: string;
	dim: number;
	total: number;
} | null> {
	const daemon = getDaemon();
	if (!daemon) return null;
	try {
		const result = (await daemon.send("health", {}, 2500)) as {
			model_version?: string;
			dim?: number;
			total?: number;
		} | null;
		if (
			!result ||
			typeof result.model_version !== "string" ||
			typeof result.dim !== "number" ||
			typeof result.total !== "number"
		) {
			return null;
		}
		return {
			modelVersion: result.model_version,
			dim: result.dim,
			total: result.total,
		};
	} catch (err) {
		console.warn(
			"⚠️ [Synapse] health に失敗しました:",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}
