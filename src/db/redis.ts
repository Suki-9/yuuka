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
          // 最大 5 回リトライし、その後は再接続を諦めて SQLite フォールバックで稼働する
          if (retries > 5) {
            console.warn("⚠️ Redis への再接続を諦めました。SQLite フォールバックモードで稼働します。");
            isRedisReady = false;
            return false;
          }
          // 3秒間隔でリトライ
          return 3000;
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
    await client.connect();
  } catch (err) {
    console.error("❌ Redis 初期接続に失敗しました。SQLite のみで動作します。:", err);
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
