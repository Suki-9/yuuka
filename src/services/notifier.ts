import type { EmbedBuilder, TextBasedChannel } from "discord.js";
import { client, customClients } from "../bot.js";
import { listBotsForUser } from "../db/botRepo.js";
import { getUserNotifyTarget } from "../db/userRepo.js";
import { isGuildAssistantBot } from "./botCapabilities.js";
import { toDiscordMarkdown } from "../utils/discordMarkdown.js";

export interface NotifyPayload {
	content?: string;
	embeds?: EmbedBuilder[];
	files?: { attachment: Buffer; name: string }[];
}

export interface NotifyTarget {
	type: "dm" | "channel";
	id?: string; // dm の場合は不要（userIdを使用）
}

/**
 * 通知を送信するDiscordクライアントを解決する。
 *
 * - botId 指定あり（秘書業務データのBot別分離）: そのBot本人のクライアントで届ける。
 *   'system_default' はデフォルト共有Bot。独自Botが未起動の場合はデフォルトBotへフォールバック。
 * - botId 指定なし（旧経路）: ユーザーが起動している秘書型独自Bot → デフォルト共有Bot の順。
 *   汎用モード（MCPアシスタント）のBotは通知に使わない（bot_attributes_requirements.md §4.2）。
 */
function resolveClientForUser(userId: string, botId?: string) {
	if (botId) {
		if (botId !== "system_default") {
			const custom = customClients.get(botId);
			if (custom && custom.readyAt) return custom;
			// 当該Botがオフラインの場合でも通知は届けたいのでデフォルトBotへフォールバック
		}
		return client.readyAt ? client : null;
	}
	try {
		const bots = listBotsForUser(userId);
		for (const bot of bots) {
			if (bot.id === "system_default") continue;
			if (isGuildAssistantBot(bot.id)) continue;
			const custom = customClients.get(bot.id);
			if (custom && custom.readyAt) return custom;
		}
	} catch (err) {
		console.error(
			`[Notifier] ユーザー ${userId} のBot一覧取得に失敗しました:`,
			err,
		);
	}
	if (client.readyAt) return client;
	return null;
}

/**
 * ユーザーへDiscord通知を送信する（リマインド・日報・朝報・Webhook通知等の共通基盤）。
 * @param target 明示指定が無ければユーザー設定の既定送信先（users.notify_target_*）→ DM の順で解決
 * @param botId 通知元のBot（秘書業務データのBot別分離）。そのBot本人のクライアントで届ける。
 * @returns 送信成功なら true
 */
export async function sendToUser(
	userId: string,
	payload: NotifyPayload,
	target?: NotifyTarget,
	botId?: string,
): Promise<boolean> {
	const botClient = resolveClientForUser(userId, botId);
	if (!botClient) {
		console.error(
			`[Notifier] 利用可能なBotクライアントがありません (user: ${userId})`,
		);
		return false;
	}

	// 送信先の解決
	let resolved: NotifyTarget = target ?? { type: "dm" };
	if (!target) {
		try {
			const pref = getUserNotifyTarget(userId);
			if (pref) resolved = pref;
		} catch {
			// ユーザー設定が取得できない場合はDMへフォールバック
		}
	}

	const messageOptions = {
		...(payload.content ? { content: toDiscordMarkdown(payload.content) } : {}),
		...(payload.embeds && payload.embeds.length > 0
			? { embeds: payload.embeds }
			: {}),
		...(payload.files && payload.files.length > 0
			? { files: payload.files }
			: {}),
	};

	if (
		!messageOptions.content &&
		!messageOptions.embeds &&
		!messageOptions.files
	) {
		return false; // 空ペイロードは送信しない
	}

	try {
		if (resolved.type === "channel" && resolved.id) {
			const channel = await botClient.channels
				.fetch(resolved.id)
				.catch(() => null);
			if (channel && channel.isTextBased() && "send" in channel) {
				// セキュリティ: 共有Botを踏み台にした第三者チャンネルへの送信・データ露出を防ぐため、
				// ギルドチャンネルの場合は対象ユーザー本人がそのチャンネルのメンバーであることを検証する
				let allowed = true;
				if ("guild" in channel && channel.guild) {
					try {
						const member = await channel.guild.members.fetch(userId);
						const perms = channel.permissionsFor(member);
						allowed = !!perms?.has("ViewChannel");
					} catch {
						allowed = false;
					}
				}

				if (allowed) {
					await (
						channel as TextBasedChannel & {
							send: (o: unknown) => Promise<unknown>;
						}
					).send(messageOptions);
					return true;
				}
				console.warn(
					`[Notifier] ユーザー ${userId} はチャンネル ${resolved.id} のメンバーではないためDMへフォールバックします`,
				);
			} else {
				console.warn(
					`[Notifier] チャンネル ${resolved.id} が見つからないためDMへフォールバックします`,
				);
			}
		}

		const user = await botClient.users.fetch(userId);
		await user.send(messageOptions);
		return true;
	} catch (err) {
		console.error(
			`[Notifier] 通知の送信に失敗しました (user: ${userId}):`,
			err,
		);
		return false;
	}
}
