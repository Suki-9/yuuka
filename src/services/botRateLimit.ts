import { getRedisClient } from "../db/redis.js";
import { getSystemSetting } from "../db/systemSettingsRepo.js";

// ─── 汎用モードの利用量制御（bot_attributes_requirements.md §6） ─────────────
//
// Bot専用キー保護のためのレート制限。カウンタは Redis のTTL付きカウンタで保持し、
// SQLite には持たない（要件 §5）。Redis 不通時はプロセス内のインメモリカウンタへ
// フォールバックする（再起動でリセットされるが、防衛線としては十分）。
// 既定値はシステム設定（system_settings）で変更可能（要件 §10-8 仮置き）。

/** レート制限既定値（システム設定キーと既定値。要件 §6 / §10-8） */
export const RATE_LIMIT_DEFAULTS = {
  userPerMinute: { key: "mcp_rate_user_per_minute", value: 5 },
  userPerDay: { key: "mcp_rate_user_per_day", value: 100 },
  guildPerDay: { key: "mcp_rate_guild_per_day", value: 1000 },
} as const;

function getLimit(def: { key: string; value: number }): number {
  const raw = getSystemSetting(def.key, String(def.value));
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : def.value;
}

/** 現在のレート制限設定値を返す（管理UI表示用） */
export function getRateLimitSettings(): { userPerMinute: number; userPerDay: number; guildPerDay: number } {
  return {
    userPerMinute: getLimit(RATE_LIMIT_DEFAULTS.userPerMinute),
    userPerDay: getLimit(RATE_LIMIT_DEFAULTS.userPerDay),
    guildPerDay: getLimit(RATE_LIMIT_DEFAULTS.guildPerDay),
  };
}

// ─── インメモリフォールバックカウンタ ────────────────────────────────────────

const memoryCounters = new Map<string, { count: number; expiresAt: number }>();

function incrementMemoryCounter(key: string, ttlSeconds: number): number {
  const now = Date.now();
  const entry = memoryCounters.get(key);
  if (!entry || entry.expiresAt <= now) {
    memoryCounters.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

// 失効済みエントリの掃除（無制限な肥大を防ぐ）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryCounters.entries()) {
    if (entry.expiresAt <= now) memoryCounters.delete(key);
  }
}, 10 * 60 * 1000).unref();

/** Redis のTTL付きカウンタをインクリメントして現在値を返す（不通時はインメモリ） */
async function incrementCounter(key: string, ttlSeconds: number): Promise<number> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, ttlSeconds);
      }
      return count;
    } catch (err) {
      console.error("⚠️ レート制限カウンタの更新に失敗しました（インメモリへフォールバック）:", err);
    }
  }
  return incrementMemoryCounter(key, ttlSeconds);
}

/** 日付サフィックス（日単位カウンタのキー衝突防止。TTLは25hで日跨ぎを吸収） */
function todaySuffix(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 超過した制限の種類（定型応答の文言出し分け用） */
  exceeded?: "user_minute" | "user_day" | "guild_day";
}

/**
 * 利用メンバーの発話1件ぶんのレート制限を消費・判定する。
 * ユーザー単位（既定: 5回/分・100回/日）とギルド単位（既定: 1,000回/日）を同時にカウントし、
 * いずれかを超過した場合は allowed = false（呼び出し側はLLMを呼ばず定型応答を返す）。
 */
export async function consumeRateLimit(
  botId: string,
  guildId: string,
  userId: string
): Promise<RateLimitResult> {
  const limits = getRateLimitSettings();
  const day = todaySuffix();

  const userMinute = await incrementCounter(`mcp_rate:${botId}:${userId}:m`, 60);
  if (userMinute > limits.userPerMinute) {
    return { allowed: false, exceeded: "user_minute" };
  }

  const userDay = await incrementCounter(`mcp_rate:${botId}:${userId}:d:${day}`, 25 * 60 * 60);
  if (userDay > limits.userPerDay) {
    return { allowed: false, exceeded: "user_day" };
  }

  const guildDay = await incrementCounter(`mcp_rate_guild:${botId}:${guildId}:d:${day}`, 25 * 60 * 60);
  if (guildDay > limits.guildPerDay) {
    return { allowed: false, exceeded: "guild_day" };
  }

  return { allowed: true };
}

/** レート制限超過時の定型応答文（要件 §6: LLMを呼ばず返す） */
export function rateLimitMessage(exceeded: NonNullable<RateLimitResult["exceeded"]>): string {
  switch (exceeded) {
    case "user_minute":
      return "⏳ 利用ペースが上限に達しました。1分ほど時間をおいてから再度お試しください。";
    case "user_day":
      return "⏳ 本日のあなたの利用回数が上限に達しました。明日また利用できます。";
    case "guild_day":
      return "⏳ このサーバーの本日の利用回数が上限に達しました。明日また利用できます。";
  }
}
