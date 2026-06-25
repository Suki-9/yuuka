import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import {
	addContact,
	type ContactRecord,
	deleteContact,
	getContactById,
	isValidBirthday,
	listContacts,
	searchContacts,
	updateContact,
} from "../db/contactRepo.js";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

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
			"知り合いの連絡先やメモ（名前・誕生日・関係・連絡先・覚え書き）を新しく登録する。\n" +
			"・例:「田中さんの誕生日は5月3日」「同僚の佐藤さんはコーヒー好き」のように人の情報を記録したい時に使う。\n" +
			"・誕生日を入れておくと、その前日に自動でお知らせが届く。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				name: {
					type: SchemaType.STRING,
					description: "名前や呼び方（例: '田中太郎', '佐藤さん'）",
				},
				birthday: {
					type: SchemaType.STRING,
					description:
						"誕生日。形式: YYYY-MM-DD。年がわからない時は --MM-DD（例: '--05-03'）。省略可。",
				},
				relationship: {
					type: SchemaType.STRING,
					description: "どんな関係か（例: '同僚', '家族', '友人'）。省略可。",
				},
				contact_info: {
					type: SchemaType.STRING,
					description: "電話番号やメールなどの連絡先。省略可。",
				},
				notes: {
					type: SchemaType.STRING,
					description: "自由なメモ（好みや覚えておきたいことなど）。省略可。",
				},
				tags: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description:
						"分類用のタグ（例: ['仕事', 'ミレニアム']）。省略可。内容を見て合うものを付ける。",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "searchContacts",
		description:
			"名前・関係・メモの一部から連絡先を探す。\n" +
			"・例:「田中さんの好みを教えて」のように、会話に出た人の情報が必要になった時に使う。\n" +
			"・連絡先は普段読み込まれていないので、その人の情報がいる時はこれで取り出す。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				query: {
					type: SchemaType.STRING,
					description: "探す手がかりの言葉（名前・呼び方・特徴の一部）",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "listContacts",
		description:
			"登録ずみの連絡先をすべて一覧で取り出す。\n" +
			"・例:「連絡先を見せて」「登録した人を全部出して」と言われた時に使う。",
		parameters: { type: SchemaType.OBJECT, properties: {} },
	},
	{
		name: "updateContact",
		description:
			"すでにある連絡先の情報を書き換える。\n" +
			"・先に searchContacts でその人のIDを調べてから呼ぶ。\n" +
			"・変えたい項目だけを渡す（触らない項目は指定しなくてよい）。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				contact_id: {
					type: SchemaType.NUMBER,
					description: "書き換えたい連絡先のID（searchContacts で調べる）",
				},
				name: {
					type: SchemaType.STRING,
					description: "名前。変える時だけ指定する。",
				},
				birthday: {
					type: SchemaType.STRING,
					description: "誕生日。形式: YYYY-MM-DD または --MM-DD。変える時だけ指定する。",
				},
				relationship: {
					type: SchemaType.STRING,
					description: "どんな関係か。変える時だけ指定する。",
				},
				contact_info: {
					type: SchemaType.STRING,
					description: "電話番号やメールなどの連絡先。変える時だけ指定する。",
				},
				notes: {
					type: SchemaType.STRING,
					description:
						"メモ。変える時だけ指定する。今のメモに書き足す時は、元の内容も含めた全文を渡す（渡した文で丸ごと置き換わるため）。",
				},
				tags: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description: "分類用のタグ。変える時だけ指定する。",
				},
			},
			required: ["contact_id"],
		},
	},
	{
		name: "deleteContact",
		description:
			"連絡先を削除する（元に戻せない）。\n" +
			"・消す前に、どの人を消すのかをユーザーに確認してから呼ぶ。",
		parameters: {
			type: SchemaType.OBJECT,
			properties: {
				contact_id: {
					type: SchemaType.NUMBER,
					description: "削除したい連絡先のID（searchContacts で調べる）",
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
