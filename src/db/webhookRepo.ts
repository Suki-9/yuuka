import { getDb } from "./database.js";
import { encryptText, generateToken } from "../utils/crypto.js";

// ─── 外部Webhook受信リポジトリ（§3.13） ──────────────────────────────────────

export interface WebhookEndpointRecord {
	id: number;
	user_id: string;
	name: string;
	token: string;
	secret_encrypted: string | null;
	secret_iv: string | null;
	secret_tag: string | null;
	notify_target_type: "dm" | "channel";
	notify_target_id: string | null;
	template: string | null;
	filter_keyword: string | null;
	create_todo: number;
	create_reminder: number;
	enabled: number;
	created_at: string;
}

export interface WebhookDeliveryRecord {
	id: number;
	endpoint_id: number;
	user_id: string;
	payload: string;
	status: "received" | "notified" | "filtered" | "failed";
	detail: string | null;
	created_at: string;
}

export interface WebhookEndpointInput {
	name: string;
	secret?: string | null;
	notifyTargetType?: "dm" | "channel";
	notifyTargetId?: string | null;
	template?: string | null;
	filterKeyword?: string | null;
	createTodo?: boolean;
	createReminder?: boolean;
}

/** 安全なビュー（シークレットは has_secret フラグのみ） */
export interface WebhookEndpointView {
	id: number;
	name: string;
	token: string;
	has_secret: boolean;
	notify_target_type: "dm" | "channel";
	notify_target_id: string | null;
	template: string | null;
	filter_keyword: string | null;
	create_todo: boolean;
	create_reminder: boolean;
	enabled: boolean;
	created_at: string;
}

export function toEndpointView(e: WebhookEndpointRecord): WebhookEndpointView {
	return {
		id: e.id,
		name: e.name,
		token: e.token,
		has_secret: !!e.secret_encrypted,
		notify_target_type: e.notify_target_type,
		notify_target_id: e.notify_target_id,
		template: e.template,
		filter_keyword: e.filter_keyword,
		create_todo: e.create_todo === 1,
		create_reminder: e.create_reminder === 1,
		enabled: e.enabled === 1,
		created_at: e.created_at,
	};
}

/**
 * Webhookエンドポイントを作成する（tokenはCSPRNG生成 §3.13.4）
 */
export function createEndpoint(
	userId: string,
	input: WebhookEndpointInput,
): WebhookEndpointRecord {
	const db = getDb();
	const token = generateToken(24); // 推測困難なURLトークン

	let enc: { encrypted: string; iv: string; authTag: string } | null = null;
	if (input.secret && input.secret.trim()) {
		enc = encryptText(input.secret.trim());
	}

	const result = db
		.prepare(
			`INSERT INTO webhook_endpoints
       (user_id, name, token, secret_encrypted, secret_iv, secret_tag,
        notify_target_type, notify_target_id, template, filter_keyword, create_todo, create_reminder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			userId,
			input.name.trim(),
			token,
			enc?.encrypted ?? null,
			enc?.iv ?? null,
			enc?.authTag ?? null,
			input.notifyTargetType ?? "dm",
			input.notifyTargetId ?? null,
			input.template?.trim() || null,
			input.filterKeyword?.trim() || null,
			input.createTodo ? 1 : 0,
			input.createReminder ? 1 : 0,
		);

	return getEndpointById(userId, Number(result.lastInsertRowid))!;
}

export function getEndpointById(
	userId: string,
	id: number,
): WebhookEndpointRecord | undefined {
	const db = getDb();
	return db
		.prepare("SELECT * FROM webhook_endpoints WHERE user_id = ? AND id = ?")
		.get(userId, id) as WebhookEndpointRecord | undefined;
}

/** 受信ルート用: トークンでエンドポイントを解決する（公開ルートのため user_id 条件なし） */
export function getEndpointByToken(
	token: string,
): WebhookEndpointRecord | undefined {
	const db = getDb();
	return db
		.prepare("SELECT * FROM webhook_endpoints WHERE token = ?")
		.get(token) as WebhookEndpointRecord | undefined;
}

export function listEndpoints(userId: string): WebhookEndpointRecord[] {
	const db = getDb();
	return db
		.prepare(
			"SELECT * FROM webhook_endpoints WHERE user_id = ? ORDER BY created_at DESC",
		)
		.all(userId) as WebhookEndpointRecord[];
}

export function updateEndpoint(
	userId: string,
	id: number,
	input: Partial<WebhookEndpointInput> & { enabled?: boolean },
): boolean {
	const current = getEndpointById(userId, id);
	if (!current) return false;

	// secret: undefined=変更なし, ""/null=解除, 値あり=更新
	let secretEnc = current.secret_encrypted;
	let secretIv = current.secret_iv;
	let secretTag = current.secret_tag;
	if (input.secret !== undefined) {
		if (input.secret && input.secret.trim()) {
			const enc = encryptText(input.secret.trim());
			secretEnc = enc.encrypted;
			secretIv = enc.iv;
			secretTag = enc.authTag;
		} else {
			secretEnc = null;
			secretIv = null;
			secretTag = null;
		}
	}

	const db = getDb();
	const result = db
		.prepare(
			`UPDATE webhook_endpoints SET
         name = ?, secret_encrypted = ?, secret_iv = ?, secret_tag = ?,
         notify_target_type = ?, notify_target_id = ?, template = ?, filter_keyword = ?,
         create_todo = ?, create_reminder = ?, enabled = ?
       WHERE user_id = ? AND id = ?`,
		)
		.run(
			input.name !== undefined ? input.name.trim() : current.name,
			secretEnc,
			secretIv,
			secretTag,
			input.notifyTargetType ?? current.notify_target_type,
			input.notifyTargetId !== undefined
				? input.notifyTargetId
				: current.notify_target_id,
			input.template !== undefined
				? input.template?.trim() || null
				: current.template,
			input.filterKeyword !== undefined
				? input.filterKeyword?.trim() || null
				: current.filter_keyword,
			input.createTodo !== undefined
				? input.createTodo
					? 1
					: 0
				: current.create_todo,
			input.createReminder !== undefined
				? input.createReminder
					? 1
					: 0
				: current.create_reminder,
			input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled,
			userId,
			id,
		);
	return result.changes > 0;
}

export function deleteEndpoint(userId: string, id: number): boolean {
	const db = getDb();
	const result = db
		.prepare("DELETE FROM webhook_endpoints WHERE user_id = ? AND id = ?")
		.run(userId, id);
	return result.changes > 0;
}

/** 受信ペイロードの監査記録（§3.13.4。8KBにtruncateして保存） */
export function addDelivery(
	endpointId: number,
	userId: string,
	payload: string,
	status: WebhookDeliveryRecord["status"],
	detail?: string,
): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO webhook_deliveries (endpoint_id, user_id, payload, status, detail)
     VALUES (?, ?, ?, ?, ?)`,
	).run(endpointId, userId, payload.slice(0, 8192), status, detail ?? null);
}

export function listDeliveries(
	userId: string,
	endpointId?: number,
	limit: number = 50,
): WebhookDeliveryRecord[] {
	const db = getDb();
	if (endpointId != null) {
		return db
			.prepare(
				`SELECT * FROM webhook_deliveries WHERE user_id = ? AND endpoint_id = ?
         ORDER BY id DESC LIMIT ?`,
			)
			.all(userId, endpointId, limit) as WebhookDeliveryRecord[];
	}
	return db
		.prepare(
			"SELECT * FROM webhook_deliveries WHERE user_id = ? ORDER BY id DESC LIMIT ?",
		)
		.all(userId, limit) as WebhookDeliveryRecord[];
}
