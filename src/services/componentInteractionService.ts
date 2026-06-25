import {
	ActionRowBuilder,
	type APIActionRowComponent,
	type APIComponentInMessageActionRow,
	ButtonBuilder,
	ButtonStyle,
} from "discord.js";
import {
	acceptShareInvite,
	getBotById,
	getShareById,
	revokeShare,
} from "../db/botRepo.js";
import { getPersonaById, importPersona } from "../db/personaRepo.js";
import { isRegisteredUser } from "../db/userRepo.js";
import {
	decideMemberRequestById,
	submitMemberRequest,
} from "./memberRequest.js";

// ─── チャネル中立インタラクション・ディスパッチ（ws_components.md §4） ──
// Discord / WS（デスクトップ）双方からボタン押下を受け、同じアクション分岐へ流す。
// responder により応答チャネル（discord.js Interaction / WS フレーム）を抽象化する。

/** ボタン応答の中立インターフェース（Discord / WS で実装が異なる）。 */
export interface InteractionResponder {
	update(opts: {
		content?: string;
		components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
	}): Promise<void>;
	reply(opts: {
		content?: string;
		ephemeral?: boolean;
		components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
	}): Promise<void>;
	followUp(opts: {
		content?: string;
		components?: APIActionRowComponent<APIComponentInMessageActionRow>[];
	}): Promise<void>;
}

/**
 * ボタン custom_id（`action:id[:extra]`）を解釈し、対応するアクションを実行する。
 * 応答は responder 経由でチャネル中立に行う（Discord は interaction、WS は フレーム送信）。
 */
export async function dispatchComponentInteraction(args: {
	/** Discord ID（WS は束縛トークン由来、Discord は interaction.user.id）。 */
	userId: string;
	customId: string;
	/** DM/デスクトップでは null。 */
	guildId?: string | null;
	responder: InteractionResponder;
	/**
	 * memreq_apply 時にオーナーDMの可読性を上げるラベル解決（任意）。
	 * Discord 経路は guild メンバーの表示名等を解決して渡す。WS/DM 経路は省略。
	 * （doc §4 の最小シグネチャに対する追加。挙動不変のため Discord 経路で温存する）。
	 */
	resolveApplicantContext?: () => Promise<{
		applicantLabel?: string;
		guildLabel?: string;
	}>;
}): Promise<void> {
	const { userId, guildId, responder } = args;
	const [action, idStr, extra] = args.customId.split(":");
	try {
		// ── 往復実証用デモ（ws_components.md §5。DESKTOP_DEMO_COMPONENTS でのみ発火） ──
		if (action === "demo_echo") {
			await responder.update({
				content: `ボタンを受け取りました: ${idStr ?? ""}`,
				components: [],
			});
			return;
		}

		// ── 利用申請（メンバー外ユーザーがボタンから申請） ──
		if (action === "memreq_apply") {
			const botId = idStr;
			const reqGuildId = extra;
			if (!botId || !reqGuildId) {
				await responder.reply({
					content: "申請情報が不正です。",
					ephemeral: true,
				});
				return;
			}
			const appCtx = args.resolveApplicantContext
				? await args.resolveApplicantContext()
				: {};
			const result = await submitMemberRequest(
				botId,
				reqGuildId,
				userId,
				undefined,
				appCtx.applicantLabel,
				appCtx.guildLabel,
			);
			await responder.reply({
				content: result.ok
					? "✅ 利用申請を送信しました。Bot作成者の承認をお待ちください。"
					: `⚠️ ${result.message}`,
				ephemeral: true,
			});
			return;
		}

		// ── 利用申請の承認/却下（BotオーナーがDMボタンから操作） ──
		if (action === "memreq_approve" || action === "memreq_reject") {
			const decision = action === "memreq_approve" ? "approved" : "rejected";
			const result = await decideMemberRequestById(
				parseInt(idStr, 10),
				decision,
				userId,
			);
			if (!result.ok) {
				await responder.reply({ content: result.message, ephemeral: true });
				return;
			}
			await responder.update({
				content:
					result.status === "approved"
						? `✅ Bot「**${result.botName}**」の利用申請を承認しました。`
						: `🚫 Bot「**${result.botName}**」の利用申請を却下しました。`,
				components: [],
			});
			return;
		}

		if (action === "share_accept" || action === "share_decline") {
			const share = getShareById(parseInt(idStr, 10));
			if (!share || share.shared_user_id !== userId) {
				await responder.reply({
					content: "この招待はあなた宛ではないか、既に無効です。",
					ephemeral: true,
				});
				return;
			}
			if (share.status !== "pending") {
				await responder.reply({
					content: "この招待は既に処理済みです。",
					ephemeral: true,
				});
				return;
			}

			if (action === "share_decline") {
				revokeShare(share.bot_id, share.shared_user_id);
				await responder.update({
					content: "招待を辞退しました。",
					components: [],
				});
				return;
			}

			acceptShareInvite(share.bot_id, share.shared_user_id);
			const bot = getBotById(share.bot_id);
			await responder.update({
				content: `✅ Bot「**${bot?.name ?? share.bot_id}**」へのアクセスが有効になりました！`,
				components: [],
			});

			// 推奨ペルソナが設定されている場合、インポート確認を表示（§5.2.2）
			if (bot?.recommended_persona_id) {
				const persona = getPersonaById(bot.recommended_persona_id);
				if (persona && persona.is_public === 1) {
					const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
						new ButtonBuilder()
							.setCustomId(`persona_import:${persona.id}`)
							.setLabel(`ペルソナ「${persona.name.slice(0, 60)}」をインポート`)
							.setStyle(ButtonStyle.Primary),
					);
					await responder.followUp({
						content: `このBotの推奨ペルソナをインポートしますか？（任意です。インポート後は独立したコピーとなります）`,
						components: [row.toJSON()],
					});
				}
			}
			return;
		}

		if (action === "persona_import") {
			if (!isRegisteredUser(userId)) {
				await responder.reply({
					content: "先にユーザー登録を完了してください。",
					ephemeral: true,
				});
				return;
			}
			const result = importPersona(userId, parseInt(idStr, 10));
			if (result) {
				await responder.update({
					content: `✅ ペルソナをインポートしました。管理画面の「ペルソナ」から適用できます。`,
					components: [],
				});
			} else {
				await responder.update({
					content:
						"ペルソナのインポートに失敗しました（非公開化された可能性があります）。",
					components: [],
				});
			}
			return;
		}
		// guildId は将来のギルドスコープアクションで使用する（現状の分岐では未使用）。
		void guildId;
	} catch (err) {
		console.error("[ComponentInteraction] インタラクション処理エラー:", err);
		throw err;
	}
}
