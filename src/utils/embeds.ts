import { EmbedBuilder } from "discord.js";

// ─── Embed 共通ビルダー（§3.0.2 リッチ返信共通仕様） ─────────────────────────

/** カラーコード規約（§3.0.2） */
export const EMBED_COLORS = {
  /** 通常情報 ブルー */
  default: 0x5865f2,
  /** 成功・完了 グリーン */
  success: 0x57f287,
  /** 警告・注意 イエロー */
  warning: 0xfee75c,
  /** エラー・失敗 レッド */
  error: 0xed4245,
  /** 天気・朝報 スカイブルー */
  weather: 0x00b0f4,
  /** 家計・支払い ゴールド */
  finance: 0xf1c40f,
  /** タスク・スケジュール パープル */
  task: 0x9b59b6,
} as const;

/** LLM向けカラーテーマ名 → カラーコードのマップ（旧テーマ名も互換維持） */
const COLOR_MAP: Record<string, number> = {
  default: EMBED_COLORS.default,
  success: EMBED_COLORS.success,
  warning: EMBED_COLORS.warning,
  error: EMBED_COLORS.error,
  weather: EMBED_COLORS.weather,
  finance: EMBED_COLORS.finance,
  task: EMBED_COLORS.task,
  // 旧テーマ名（後方互換）
  info: 0x5bc0eb,
  news: 0xf5a623,
  data: EMBED_COLORS.task,
  expense: EMBED_COLORS.finance,
};

export interface RichContentField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface RichContentData {
  title: string;
  description?: string;
  color?: string;
  thumbnail_url?: string;
  image_url?: string;
  fields?: RichContentField[];
  footer?: string;
}

/**
 * 汎用リッチコンテンツEmbedを構築する（showRichContent Function・各サービスの通知から使用）
 */
export function buildRichContentEmbed(data: RichContentData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(data.title.slice(0, 256))
    .setColor(COLOR_MAP[data.color ?? "default"] ?? EMBED_COLORS.default)
    .setTimestamp();

  if (data.description) embed.setDescription(data.description.slice(0, 4000));

  if (data.fields && data.fields.length > 0) {
    embed.addFields(
      data.fields.slice(0, 25).map((f) => ({
        name: String(f.name).slice(0, 256),
        value: String(f.value).slice(0, 1024),
        inline: f.inline ?? false,
      }))
    );
  }

  if (data.thumbnail_url) embed.setThumbnail(data.thumbnail_url);
  if (data.image_url) embed.setImage(data.image_url);
  if (data.footer) embed.setFooter({ text: data.footer.slice(0, 2048) });

  return embed;
}
