import crypto from "node:crypto";
import { EmbedBuilder } from "discord.js";
import { addAuditLog } from "../db/auditRepo.js";
import { addReminder } from "../db/reminderRepo.js";
import { addTodo } from "../db/todoRepo.js";
import { addDelivery, type WebhookEndpointRecord } from "../db/webhookRepo.js";
import { decryptText } from "../utils/crypto.js";
import { generateAuxText } from "./llmClient.js";
import { sendToUser } from "./notifier.js";

// ─── Webhook受信処理（§3.13） ────────────────────────────────────────────────
// 受信ペイロードを（可能なら）LLMが解釈して人間向け通知文を生成し、
// ユーザーのDiscordへ通知する。設定に応じてToDo/リマインドへ変換する。

export interface WebhookProcessResult {
	status: "notified" | "filtered" | "failed";
	detail: string;
}

// ─── リプレイ防止（直近に受理した署名を一定時間記憶し、同一署名の再送を拒否する） ──
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5分
const seenSignatures = new Map<string, number>(); // `${endpointId}:${sigHex}` -> expiresAt

setInterval(() => {
	const now = Date.now();
	for (const [k, exp] of seenSignatures) {
		if (exp <= now) seenSignatures.delete(k);
	}
}, REPLAY_WINDOW_MS).unref();

/** 同一署名が直近に受理済みなら true（リプレイ）。未受理なら記録して false。 */
function isReplayedSignature(endpointId: number, sigHex: string): boolean {
	const key = `${endpointId}:${sigHex}`;
	const now = Date.now();
	const exp = seenSignatures.get(key);
	if (exp && exp > now) return true;
	seenSignatures.set(key, now + REPLAY_WINDOW_MS);
	return false;
}

/**
 * HMAC署名を検証する（X-Hub-Signature-256: sha256=<hex> 形式 §3.13.4）
 */
function verifyHmacSignature(
	endpoint: WebhookEndpointRecord,
	rawBody: Buffer,
	signatureHeader?: string,
): boolean {
	if (
		!endpoint.secret_encrypted ||
		!endpoint.secret_iv ||
		!endpoint.secret_tag
	) {
		// シークレット未設定のエンドポイントは認証不能のため受理しない（デフォルト拒否）。
		// 新規作成時にシークレットを必須化しているため、これは旧データの保護にも働く。
		return false;
	}
	if (!signatureHeader) return false;

	let secret: string;
	try {
		secret = decryptText(
			endpoint.secret_encrypted,
			endpoint.secret_iv,
			endpoint.secret_tag,
		);
	} catch (err) {
		console.error(
			`[Webhook] シークレットの復号に失敗しました (endpoint: ${endpoint.id}):`,
			err,
		);
		return false;
	}

	// "sha256=<hex>" 形式（GitHub互換）と素のhexの両方を受け付ける
	const provided = signatureHeader.replace(/^sha256=/i, "").trim();
	const expected = crypto
		.createHmac("sha256", secret)
		.update(rawBody)
		.digest("hex");

	try {
		const providedBuf = Buffer.from(provided, "hex");
		const expectedBuf = Buffer.from(expected, "hex");
		if (providedBuf.length !== expectedBuf.length) return false;
		return crypto.timingSafeEqual(providedBuf, expectedBuf);
	} catch {
		return false;
	}
}

/** ペイロードをLLM抜きで整形するフォールバック（JSONの主要キーを列挙） */
function buildFallbackSummary(payloadText: string): string {
	try {
		const parsed = JSON.parse(payloadText);
		if (parsed && typeof parsed === "object") {
			const lines: string[] = [];
			const entries = Object.entries(parsed as Record<string, unknown>).slice(
				0,
				12,
			);
			for (const [key, value] of entries) {
				let str: string;
				if (value === null || value === undefined) {
					str = String(value);
				} else if (typeof value === "object") {
					str = JSON.stringify(value).slice(0, 120);
				} else {
					str = String(value).slice(0, 120);
				}
				lines.push(`- **${key}**: ${str}`);
			}
			return lines.join("\n") || "（空のペイロード）";
		}
	} catch {}
	return payloadText.slice(0, 800);
}

/**
 * 受信したWebhookを処理する（HMAC検証 → フィルタ → LLM解釈 → 通知 → 変換）
 * 公開ルートからは即時200応答後に非同期で呼ばれる。
 */
export async function processIncomingWebhook(
	endpoint: WebhookEndpointRecord,
	rawBody: Buffer,
	signatureHeader?: string,
): Promise<WebhookProcessResult> {
	const payloadText = rawBody.toString("utf-8");
	const userId = endpoint.user_id;

	// 1. HMAC署名検証（§3.13.4）
	//    検証失敗は監査ログを膨らませないよう deliveries のみに記録する
	if (!verifyHmacSignature(endpoint, rawBody, signatureHeader)) {
		const detail = "HMAC署名の検証に失敗しました";
		addDelivery(endpoint.id, userId, payloadText, "failed", detail);
		console.warn(`[Webhook] ${endpoint.name}: ${detail}`);
		return { status: "failed", detail };
	}

	// 1b. リプレイ検出（同一署名の再送を一定時間内は拒否する §3.13.4）
	const sigHex = (signatureHeader || "")
		.replace(/^sha256=/i, "")
		.trim()
		.toLowerCase();
	if (sigHex && isReplayedSignature(endpoint.id, sigHex)) {
		const detail = "リプレイ（同一署名の再送）を検出したため拒否しました";
		addDelivery(endpoint.id, userId, payloadText, "failed", detail);
		console.warn(`[Webhook] ${endpoint.name}: ${detail}`);
		return { status: "failed", detail };
	}

	// 検証を通過した受信のみ監査ログに記録する
	addAuditLog(userId, "webhook.received", endpoint.name);

	// 2. キーワードフィルタ（合致しないペイロードは通知しない §3.13.3）
	if (
		endpoint.filter_keyword &&
		!payloadText.includes(endpoint.filter_keyword)
	) {
		const detail = `フィルタ「${endpoint.filter_keyword}」に合致しないため通知をスキップしました`;
		addDelivery(endpoint.id, userId, payloadText, "filtered", detail);
		return { status: "filtered", detail };
	}

	// 3. LLMによるペイロード解釈（§3.13.2。APIキー未設定・失敗時はフォールバック整形）
	let summary: string | null = null;
	try {
		const templateInstruction = endpoint.template
			? `\n\n通知文は次のテンプレート・指示に従って整形してください:\n${endpoint.template}`
			: "";
		summary = await generateAuxText(
			userId,
			`外部サービス「${endpoint.name}」から以下のWebhookペイロードを受信しました。` +
				`内容を解釈し、Discord通知用の簡潔で分かりやすい日本語メッセージ（500文字以内、重要な情報を優先）を生成してください。` +
				`通知文のみを出力し、前置きや説明は不要です。${templateInstruction}\n\n` +
				`ペイロード:\n${payloadText.slice(0, 8000)}`,
		);
	} catch (err) {
		console.warn(
			`[Webhook] LLM解釈に失敗しました (endpoint: ${endpoint.name}):`,
			err,
		);
	}

	const notifyText = summary?.trim() || buildFallbackSummary(payloadText);

	// 4. Discordへ通知（Embed: 🪝 + ブルー §3.0.2）
	const embed = new EmbedBuilder()
		.setTitle(`🪝 ${endpoint.name}`)
		.setColor(0x5865f2)
		.setDescription(notifyText.slice(0, 4000))
		.setFooter({ text: "外部Webhook通知" })
		.setTimestamp();

	const sent = await sendToUser(
		userId,
		{ embeds: [embed] },
		{
			type: endpoint.notify_target_type,
			id: endpoint.notify_target_id ?? undefined,
		},
	);

	if (!sent) {
		const detail = "Discord通知の送信に失敗しました";
		addDelivery(endpoint.id, userId, payloadText, "failed", detail);
		return { status: "failed", detail };
	}

	const conversions: string[] = [];

	// 5. ToDoへの変換（§3.13.3）
	if (endpoint.create_todo === 1) {
		try {
			const firstLine = notifyText.split("\n")[0].slice(0, 80);
			// Webhookは全Bot共有のため、生成されるToDo/リマインドはデフォルト秘書に帰属させる（§v3）
			addTodo(userId, "system_default", {
				title: `[Webhook] ${firstLine}`,
				description: `Webhook「${endpoint.name}」からの自動登録\n\n${notifyText.slice(0, 500)}`,
				tags: ["webhook", endpoint.name],
			});
			conversions.push("ToDo登録");
		} catch (err) {
			console.error(
				`[Webhook] ToDo変換に失敗しました (endpoint: ${endpoint.name}):`,
				err,
			);
		}
	}

	// 6. リマインドへの変換（1時間後の単発リマインド §3.13.3）
	if (endpoint.create_reminder === 1) {
		try {
			const firstLine = notifyText.split("\n")[0].slice(0, 100);
			addReminder(userId, "system_default", {
				message: `[Webhook: ${endpoint.name}] ${firstLine}`,
				triggerAt: new Date(Date.now() + 60 * 60 * 1000),
				targetType: endpoint.notify_target_type,
				targetId: endpoint.notify_target_id ?? undefined,
				source: "webhook",
				sourceId: String(endpoint.id),
			});
			conversions.push("リマインド設定(1時間後)");
		} catch (err) {
			console.error(
				`[Webhook] リマインド変換に失敗しました (endpoint: ${endpoint.name}):`,
				err,
			);
		}
	}

	const detail =
		`通知済み${conversions.length > 0 ? `（${conversions.join("・")}）` : ""}` +
		(summary ? "" : "（LLM解釈なし・フォールバック整形）");
	addDelivery(endpoint.id, userId, payloadText, "notified", detail);
	console.log(`🪝 [Webhook] ${endpoint.name}: ${detail}`);
	return { status: "notified", detail };
}
