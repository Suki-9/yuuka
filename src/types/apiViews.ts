import { z } from "zod";

// ─── APIレスポンスのビュー（DTO）スキーマ ───────────────────────────────────
// セキュリティ: HTTP応答へ出してよいフィールドを zod スキーマで明示的に定義し、シリアライザは
// 必ず該当スキーマの parse() を通す。z.object() はスキーマに無いキーを既定で除去（strip）するため、
// 生のDBレコードがシリアライザへ紛れ込んでも、機密列（*_encrypted / *_iv / *_tag・password_hash・
// salt 等）やスコープキー・内部管理列は構造的に応答へ出ない（フェイルクローズ）。
// 「フロントが必要とするフィールドだけを返す」allowlist の単一の真実をここに集約する。

/** GET /api/bots / POST /api/bots が返す Bot ビュー（Discordトークン・Gemini APIキーの暗号文は不可） */
export const botViewSchema = z.object({
	id: z.string(),
	user_id: z.string(),
	name: z.string(),
	recommended_persona_id: z.number().nullable(),
	persona_id: z.number().nullable(),
	capabilities: z.string(),
	discord_username: z.string().nullable(),
	discord_avatar_url: z.string().nullable(),
	// application/client ID は招待リンク・プロフィールURLの生成に必要。Discord上で公開される
	// 識別子のため応答に含めてよい（暗号文トークン等の機密値とは性質が異なる）。
	discord_application_id: z.string().nullable(),
	suspended: z.number(),
	created_at: z.string(),
	updated_at: z.string(),
	preset: z.string(),
	preset_display_name: z.string(),
	has_gemini_key: z.boolean(),
	has_token: z.boolean(),
	running: z.boolean(),
	connected: z.boolean(),
	shared: z.boolean(),
});
export type BotView = z.infer<typeof botViewSchema>;

/** GET /api/contacts / POST /api/contacts/save が返す連絡先ビュー（user_id/bot_id・内部管理列は不可） */
export const contactViewSchema = z.object({
	id: z.number(),
	name: z.string(),
	birthday: z.string().nullable(),
	relationship: z.string().nullable(),
	contact_info: z.string().nullable(),
	notes: z.string().nullable(),
	tags: z.array(z.string()),
	created_at: z.string(),
	updated_at: z.string(),
});
export type ContactView = z.infer<typeof contactViewSchema>;
