import { randomUUID } from "node:crypto";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { config } from "../config.js";
import { listBotsForUser } from "../db/botRepo.js";
import {
	type BotInfo,
	handleChatMessage,
	handleReset,
	type IncomingMsg,
	type OutboundFrame,
} from "../services/chatChannelService.js";
import {
	dispatchComponentInteraction,
	type InteractionResponder,
} from "../services/componentInteractionService.js";
import type { SessionUser } from "../types/contracts.js";

// ─── /ws/chat 接続管理（desktop_client backend_api.md §2/§3） ─────────────────
// 1 接続 = 1 Bot 束縛。keepalive（ping/pong）・1 接続 1 ターン直列・添付上限・
// ready フレーム配布を担う。会話本体は chatChannelService（→ processMessage 無改修）。

/** upgrade 受理後に handleUpgrade で使う WS サーバ（HTTP サーバには紐付けない）。 */
export const chatWss = new WebSocketServer({ noServer: true });

const PING_INTERVAL_MS = 30_000;
/** 1 接続あたりの未処理ターンの上限（バックプレッシャ。超過は rate_limited）。 */
const MAX_QUEUED_TURNS = 4;

function toBotInfo(b: {
	id: string;
	name: string;
	discord_avatar_url: string | null;
}): BotInfo {
	return {
		id: b.id,
		name: b.name,
		discord_avatar_url: b.discord_avatar_url ?? null,
		// プライマリ Bot の概念は未導入のため、常駐の既定 Bot（system_default）をプライマリ扱いとする。
		primary: b.id === "system_default",
	};
}

/** RawData（Buffer | Buffer[] | ArrayBuffer）を Buffer へ正規化する。 */
function toBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (Buffer.isBuffer(data)) return data;
	return Buffer.from(data as ArrayBuffer);
}

/** 任意の値が {mime,data} 形か検証して取り出す（不正は undefined）。 */
function asAttachment(v: unknown): { mime: string; data: string } | undefined {
	if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		if (typeof o.mime === "string" && typeof o.data === "string") {
			return { mime: o.mime, data: o.data };
		}
	}
	return undefined;
}

/**
 * 1 つの WS 接続を処理する。server.ts の upgrade ハンドラから
 * `chatWss.handleUpgrade(..., (ws) => handleChatConnection(ws, user, botId))` で呼ばれる。
 */
export function handleChatConnection(
	ws: WebSocket,
	user: SessionUser,
	botId: string,
): void {
	const send = (frame: OutboundFrame): void => {
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
	};
	const maxBytes = config.desktopMaxUploadMb * 1024 * 1024;

	// ── ready: 束縛 Bot・所有/共有 Bot 一覧・添付上限を最初に配布する ──
	const botInfos = listBotsForUser(user.discordId).map(toBotInfo);
	const bound =
		botInfos.find((b) => b.id === botId) ??
		({
			id: botId,
			name: botId,
			discord_avatar_url: null,
			primary: botId === "system_default",
		} satisfies BotInfo);
	send({
		type: "ready",
		user,
		bot: bound,
		bots: botInfos,
		maxUploadMb: config.desktopMaxUploadMb,
	});

	// ── keepalive（ping/pong）。無応答でクローズ ──
	let isAlive = true;
	ws.on("pong", () => {
		isAlive = true;
	});
	const pingTimer = setInterval(() => {
		if (!isAlive) {
			ws.terminate();
			return;
		}
		isAlive = false;
		try {
			ws.ping();
		} catch {
			// 送信失敗は次回 terminate で回収
		}
	}, PING_INTERVAL_MS);

	// ── 1 接続 1 ターン直列（処理中の新規 msg は待機。過剰滞留は弾く） ──
	let chain: Promise<void> = Promise.resolve();
	let queued = 0;

	ws.on("message", (data: RawData) => {
		const buf = toBuffer(data);
		if (buf.length > maxBytes) {
			send({
				type: "error",
				code: "too_large",
				message: `メッセージが大きすぎます（上限 ${config.desktopMaxUploadMb}MB）。画像を縮小するか音声を短くしてください。`,
			});
			return;
		}

		let parsed: Record<string, unknown>;
		try {
			const obj = JSON.parse(buf.toString("utf8"));
			if (!obj || typeof obj !== "object") return;
			parsed = obj as Record<string, unknown>;
		} catch {
			send({
				type: "error",
				code: "internal",
				message: "不正なメッセージ形式です。",
			});
			return;
		}

		switch (parsed.type) {
			case "ping":
				// アプリ層 ping（WS ping/pong を使うため通常は不要）。応答は不要。
				return;
			case "reset":
				chain = chain
					.then(() => handleReset(user.discordId, botId))
					.catch((e) => console.error("[ws/chat] reset failed:", e));
				return;
			case "msg": {
				if (queued >= MAX_QUEUED_TURNS) {
					send({
						type: "error",
						code: "rate_limited",
						message: "処理が混み合っています。少し待って再送してください。",
					});
					return;
				}
				const incoming: IncomingMsg = {
					text: typeof parsed.text === "string" ? parsed.text : "",
					image: asAttachment(parsed.image),
					audio: asAttachment(parsed.audio),
					replyToId:
						typeof parsed.replyToId === "string" ? parsed.replyToId : undefined,
				};
				queued++;
				chain = chain
					.then(() => handleChatMessage(send, user, botId, incoming))
					.catch((e) => console.error("[ws/chat] message failed:", e))
					.finally(() => {
						queued--;
					});
				return;
			}
			case "interaction": {
				// ボタン押下（ws_components.md §3-4）。チャネル中立ディスパッチャへ渡す。
				const messageId =
					typeof parsed.messageId === "string" ? parsed.messageId : "";
				const customId =
					typeof parsed.customId === "string" ? parsed.customId : "";
				if (!customId) return;

				// WS 用 responder: update → 元メッセージ書き換え、reply/followUp → 新規 push。
				const responder: InteractionResponder = {
					update: async (opts) => {
						send({
							type: "update",
							messageId,
							...(opts.content !== undefined ? { text: opts.content } : {}),
							...(opts.components !== undefined
								? { components: opts.components }
								: {}),
						});
					},
					reply: async (opts) => {
						send({
							type: "push",
							text: opts.content ?? "",
							embeds: [],
							files: [],
							messageId: randomUUID(),
							...(opts.components !== undefined
								? { components: opts.components }
								: {}),
						});
					},
					followUp: async (opts) => {
						send({
							type: "push",
							text: opts.content ?? "",
							embeds: [],
							files: [],
							messageId: randomUUID(),
							...(opts.components !== undefined
								? { components: opts.components }
								: {}),
						});
					},
				};
				chain = chain
					.then(() =>
						dispatchComponentInteraction({
							userId: user.discordId,
							customId,
							guildId: null,
							responder,
						}),
					)
					.catch((e) => console.error("[ws/chat] interaction failed:", e));
				return;
			}
			default:
				return;
		}
	});

	ws.on("close", () => {
		clearInterval(pingTimer);
	});
	ws.on("error", (err) => {
		console.error("[ws/chat] socket error:", err);
	});
}
