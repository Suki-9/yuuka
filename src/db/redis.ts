import { createClient, type RedisClientType } from "redis";
import { config } from "../config.js";

let client: RedisClientType | null = null;
let isRedisReady = false;

/**
 * Redisクライアントを初期化し、接続します
 */
export async function initRedis(): Promise<void> {
  if (client) return;

  try {
    client = createClient({
      url: config.redisUrl,
      socket: {
        reconnectStrategy(retries) {
          // 24/365 運用のため再接続は決して諦めない。
          // 切断中は getRedisClient() が null を返し SQLite フォールバックで稼働し、
          // Redis 復旧時に 'ready' イベントで自動的にキャッシュ層へ復帰する。
          const delay = Math.min(1000 * Math.pow(2, Math.min(retries, 5)), 30_000);
          if (retries > 0 && retries % 10 === 0) {
            console.warn(`⚠️ Redis 再接続を継続中 (${retries}回目)。SQLite フォールバックで稼働しています。`);
          }
          return delay;
        }
      }
    }) as RedisClientType;

    client.on("error", (err) => {
      console.error("❌ Redis エラーが発生しました:", err);
      isRedisReady = false;
    });

    client.on("ready", () => {
      console.log("✅ Redis への接続が完了しました。インメモリDBキャッシュを有効にします。");
      isRedisReady = true;
    });

    client.on("end", () => {
      console.log("ℹ️ Redis 接続が切断されました。");
      isRedisReady = false;
    });

    console.log(`🔌 Redis に接続中: ${config.redisUrl}`);
    // Redis がダウンしていても起動をブロックしない: 初回接続は5秒だけ待ち、
    // 未接続のままでもバックグラウンドで再接続を継続させる（'ready' で自動復帰）。
    const connecting = client.connect().catch((err) => {
      console.error("❌ Redis 接続エラー（バックグラウンドで再接続を継続します）:", err);
    });
    await Promise.race([
      connecting,
      new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          console.warn("⚠️ Redis 初回接続が5秒以内に確立しませんでした。SQLite フォールバックで起動を続行します。");
          resolve();
        }, 5000);
        t.unref();
      }),
    ]);
  } catch (err) {
    console.error("❌ Redis クライアントの初期化に失敗しました。SQLite のみで動作します。:", err);
    client = null;
    isRedisReady = false;
  }
}

/**
 * 有効な Redis クライアントを取得します
 * Redis が利用不可能な場合は null を返します
 */
export function getRedisClient(): RedisClientType | null {
  if (isRedisReady && client) {
    return client;
  }
  return null;
}

/**
 * Redis 接続を安全に閉じます
 */
export async function closeRedis(): Promise<void> {
  if (client) {
    console.log("🔌 Redis 接続を切断しています...");
    try {
      if (client.isOpen) {
        await client.quit();
      }
    } catch (err) {
      console.error("Redis 切断中にエラーが発生しました:", err);
      try {
        if (client.isOpen) await client.disconnect();
      } catch (e) {}
    } finally {
      client = null;
      isRedisReady = false;
    }
  }
}
