import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
	addContact,
	updateContact,
	deleteContact,
	searchContacts,
	listContacts,
	getContactById,
	isValidBirthday,
	type ContactRecord,
} from "../db/contactRepo.js";

// ─── 連絡先管理 Function（§3.11） ────────────────────────────────────────────

function toContactView(c: ContactRecord) {
	let tags: string[] = [];
	try {
		tags = JSON.parse(c.tags);
	} catch {}
	return {
		id: c.id,
		name: c.name,
		birthday: c.birthday,
		relationship: c.relationship,
		contact_info: c.contact_info,
		notes: c.notes,
		tags,
	};
}

const declarations: FunctionDeclaration[] = [
	{
		name: "addContact",
		description:
			"人物の連絡先・メモ（氏名・誕生日・関係性・連絡先情報・特記事項）を登録します。" +
			"「田中さんの誕生日は5月3日」「同僚の佐藤さんはコーヒー好き」のような人物情報を記録する際に呼び出します。" +
			"誕生日が登録されると前日に自動でリマインド通知されます（§3.11）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description: "氏名・呼称（例: '田中太郎', '佐藤さん'）",
				},
				birthday: {
					type: SchemaType.STRING,
					description:
						"誕生日。YYYY-MM-DD形式。年が不明な場合は --MM-DD 形式（例: '--05-03'）（任意）",
				},
				relationship: {
					type: SchemaType.STRING,
					description: "関係性（例: '同僚', '家族', '友人'）（任意）",
				},
				contact_info: {
					type: SchemaType.STRING,
					description: "電話・メール等の連絡先（任意）",
				},
				notes: {
					type: SchemaType.STRING,
					description: "自由記述メモ（好み・特記事項など）（任意）",
				},
				tags: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description:
						"分類タグ（例: ['仕事', 'ミレニアム']）（任意。内容から適切に付与）",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "searchContacts",
		description:
			"氏名・関係性・メモの部分一致で連絡先を検索します。会話で特定の人物に言及されたとき（例:「田中さんの好みを教えて」）、" +
			"その人物の情報が必要なら本関数で動的に取得してください（連絡先はコンテキストに常時注入されません §3.11.3）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				query: {
					type: SchemaType.STRING,
					description: "検索キーワード（氏名・呼称・属性の一部）",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "listContacts",
		description:
			"登録済みの連絡先一覧を取得します。「連絡先を見せて」などの依頼時に呼び出します。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "updateContact",
		description:
			"既存の連絡先情報を更新します。searchContacts でIDを確認してから、変更するフィールドのみ指定してください。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				contact_id: {
					type: SchemaType.NUMBER,
					description: "更新する連絡先のID",
				},
				name: {
					type: SchemaType.STRING,
					description: "氏名（変更する場合のみ）",
				},
				birthday: {
					type: SchemaType.STRING,
					description: "誕生日 YYYY-MM-DD または --MM-DD（変更する場合のみ）",
				},
				relationship: {
					type: SchemaType.STRING,
					description: "関係性（変更する場合のみ）",
				},
				contact_info: {
					type: SchemaType.STRING,
					description: "連絡先情報（変更する場合のみ）",
				},
				notes: {
					type: SchemaType.STRING,
					description:
						"メモ（変更する場合のみ。既存メモに追記する場合は既存内容も含めた全文を渡す）",
				},
				tags: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description: "タグ（変更する場合のみ）",
				},
			},
			required: ["contact_id"],
		},
	},
	{
		name: "deleteContact",
		description: "連絡先を削除します。削除前にユーザーへ対象を確認すること。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				contact_id: {
					type: SchemaType.NUMBER,
					description: "削除する連絡先のID",
				},
			},
			required: ["contact_id"],
		},
	},
];

const handlers: FunctionModule["handlers"] = {
	addContact(ctx: ToolContext, args: Record<string, unknown>): string {
		const name = String(args.name ?? "").trim();
		if (!name) {
			return JSON.stringify({ success: false, message: "氏名は必須です。" });
		}

		const birthday = args.birthday ? String(args.birthday).trim() : null;
		if (birthday && !isValidBirthday(birthday)) {
			return JSON.stringify({
				success: false,
				message:
					"誕生日は YYYY-MM-DD 形式（年不明なら --MM-DD 形式）で指定してください。",
			});
		}

		const contact = addContact(ctx.userId, ctx.botId, {
			name,
			birthday,
			relationship: args.relationship ? String(args.relationship).trim() : null,
			contactInfo: args.contact_info ? String(args.contact_info).trim() : null,
			notes: args.notes ? String(args.notes).trim() : null,
			tags: Array.isArray(args.tags)
				? (args.tags as unknown[]).map(String)
				: [],
		});

		return JSON.stringify({
			success: true,
			message: `連絡先「${name}」を登録しました👤`,
			contact: toContactView(contact),
		});
	},

	searchContacts(ctx: ToolContext, args: Record<string, unknown>): string {
		const query = String(args.query ?? "").trim();
		if (!query) {
			return JSON.stringify({
				success: false,
				message: "検索キーワードが空です。",
			});
		}
		const results = searchContacts(ctx.userId, ctx.botId, query);
		return JSON.stringify({
			success: true,
			count: results.length,
			contacts: results.map(toContactView),
		});
	},

	listContacts(ctx: ToolContext): string {
		const results = listContacts(ctx.userId, ctx.botId);
		return JSON.stringify({
			success: true,
			count: results.length,
			contacts: results.map(toContactView),
		});
	},

	updateContact(ctx: ToolContext, args: Record<string, unknown>): string {
		const id = Number(args.contact_id);
		if (!Number.isInteger(id)) {
			return JSON.stringify({
				success: false,
				message: "contact_id が不正です。",
			});
		}
		const current = getContactById(ctx.userId, ctx.botId, id);
		if (!current) {
			return JSON.stringify({
				success: false,
				message: "指定された連絡先が見つかりません。",
			});
		}

		const birthday =
			args.birthday !== undefined ? String(args.birthday).trim() : undefined;
		if (birthday && !isValidBirthday(birthday)) {
			return JSON.stringify({
				success: false,
				message:
					"誕生日は YYYY-MM-DD 形式（年不明なら --MM-DD 形式）で指定してください。",
			});
		}

		const ok = updateContact(ctx.userId, ctx.botId, id, {
			...(args.name !== undefined ? { name: String(args.name).trim() } : {}),
			...(birthday !== undefined ? { birthday } : {}),
			...(args.relationship !== undefined
				? { relationship: String(args.relationship).trim() }
				: {}),
			...(args.contact_info !== undefined
				? { contactInfo: String(args.contact_info).trim() }
				: {}),
			...(args.notes !== undefined ? { notes: String(args.notes).trim() } : {}),
			...(Array.isArray(args.tags)
				? { tags: (args.tags as unknown[]).map(String) }
				: {}),
		});

		const updated = getContactById(ctx.userId, ctx.botId, id);
		return JSON.stringify({
			success: ok,
			message: ok
				? `連絡先「${updated?.name}」を更新しました👤`
				: "更新に失敗しました。",
			contact: updated ? toContactView(updated) : undefined,
		});
	},

	deleteContact(ctx: ToolContext, args: Record<string, unknown>): string {
		const id = Number(args.contact_id);
		if (!Number.isInteger(id)) {
			return JSON.stringify({
				success: false,
				message: "contact_id が不正です。",
			});
		}
		const ok = deleteContact(ctx.userId, ctx.botId, id);
		return JSON.stringify({
			success: ok,
			message: ok
				? "連絡先を削除しました🗑️"
				: "指定された連絡先が見つかりませんでした。",
		});
	},
};

/** 連絡先管理 FunctionModule */
export const contactFunctions: FunctionModule = {
	declarations,
	handlers,
};
