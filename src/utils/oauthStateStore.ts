import { getRedisClient } from "../db/redis.js";
import { generateToken } from "./crypto.js";

// ─── OAuth state（CSRF対策の一回限りnonce） ──────────────────────────────────
//
// Google OAuth 連携フロー（settingsRoutes.ts）の state パラメータを、開始セッション
// （ユーザー）に紐づくランダムな一回限りの値にするためのストア。
// 開始時に createOAuthState(userId) で発行し、コールバックで consumeOAuthState(state) し、
// 戻ってきた userId と現在のセッションユーザーが一致することを確認する。
// Redis（TTL付き）優先、不通時は in-memory フォールバック。

const STATE_PREFIX = "oauth_state:";
const TTL_SECONDS = 10 * 60; // 10分

interface MemoryEntry {
  userId: string;
  expiresAt: number;
}
const memoryStates = new Map<string, MemoryEntry>();

const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of memoryStates) {
    if (v.expiresAt <= now) memoryStates.delete(k);
  }
}, 5 * 60 * 1000);
sweepTimer.unref();

/** 新しい state nonce を発行し、userId に紐づけて保存する */
export async function createOAuthState(userId: string): Promise<string> {
  const state = generateToken(32);
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(STATE_PREFIX + state, userId, { EX: TTL_SECONDS });
      return state;
    } catch {
      // フォールバックへ
    }
  }
  memoryStates.set(state, { userId, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  return state;
}

/**
 * state を検証し消費する（一回限り）。有効なら紐づく userId を返し、無効/期限切れなら null。
 */
export async function consumeOAuthState(state: string): Promise<string | null> {
  if (!state) return null;
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = STATE_PREFIX + state;
      const userId = await redis.get(key);
      if (userId) {
        await redis.del(key);
        return userId;
      }
      // Redisに無ければ in-memory も確認（移行期の救済）
    } catch {
      // フォールバックへ
    }
  }
  const entry = memoryStates.get(state);
  if (!entry) return null;
  memoryStates.delete(state);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.userId;
}
