import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import { buildRichContentEmbed } from "../utils/embeds.js";

// ─── リッチコンテンツEmbed表示（§3.0.2） ─────────────────────────────────────
// core capability の常時有効モジュール（selectable=false）。全Botに含まれる。

export const richContentModule: FunctionModule = {
	declarations: [
		{
			name: "showRichContent",
			description:
				"天気・ニュース・株価・路線情報・一覧などを、色付きカード（DiscordのEmbed）に整えて見せる。\n" +
				"・一覧やまとめ、確認のお願い、エラー通知など、文章だけより見やすく伝えたい時に積極的に使う。\n" +
				"・このツールはカードを送信待ちに積むだけで、あとで返信の文章と一緒にDiscordへ届く。\n" +
				"・グラフ画像にした方がよい数値データ → 代わりに sendChart を使う。",
			parameters: {
				type: SchemaType.OBJECT,
				properties: {
					title: {
						type: SchemaType.STRING,
						description: "カードの見出し（例: '🌤️ 東京の今日の天気'）",
					},
					description: {
						type: SchemaType.STRING,
						description: "見出しのすぐ下に出す説明文（省略可）",
					},
					color: {
						type: SchemaType.STRING,
						description:
							"カードの色（内容に合わせて選ぶ）: default=青・ふつうの情報, success=緑・完了, warning=黄・注意, error=赤・失敗, weather=空色・天気/朝の知らせ, finance=金色・家計/支払い, task=紫・タスク/予定, info=水色, news=オレンジ, data=紫",
					},
					fields: {
						type: SchemaType.ARRAY,
						description:
							"カードに並べる項目の配列。各項目は名前と値のペア。最大25件まで",
						items: {
							type: SchemaType.OBJECT,
							properties: {
								name: {
									type: SchemaType.STRING,
									description: "項目の見出し（ラベル）",
								},
								value: {
									type: SchemaType.STRING,
									description: "フィールドの値",
								},
								inline: {
									type: SchemaType.BOOLEAN,
									description: "横並び表示にするか（デフォルト: false）",
								},
							},
							required: ["name", "value"],
						},
					},
					footer: {
						type: SchemaType.STRING,
						description:
							"フッターに表示する補足テキスト（例: 'データ提供: 気象庁'）（任意）",
					},
				},
				required: ["title"],
			},
		},
	],
	handlers: {
		showRichContent(ctx: ToolContext, args): string {
			// リッチ返信が無効の場合はEmbedを生成しない（§3.0.5）
			if (!ctx.richReplyEnabled) {
				return JSON.stringify({
					success: false,
					message:
						"ユーザー設定によりリッチ返信は無効です。内容はプレーンテキストで伝えてください。",
				});
			}
			const data = args as {
				title: string;
				description?: string;
				color?: string;
				fields?: Array<{ name: string; value: string; inline?: boolean }>;
				footer?: string;
			};
			if (!data.title) {
				return JSON.stringify({
					success: false,
					message: "title は必須です。",
				});
			}
			ctx.embeds.push(buildRichContentEmbed(data));
			return JSON.stringify({
				success: true,
				message:
					"Embedを返信に添付しました。本文では要点のみ簡潔に補足してください。",
			});
		},
	},
};
