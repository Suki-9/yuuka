import { getBotById } from "../db/botRepo.js";
import { isKnownSelectableModule } from "../functions/index.js";

// ─── 有効モジュール解決サービス（function_modularization.md §4.2） ─────────────
//
// Botインスタンス単位の enabled_modules（有効モジュールIDのJSON配列）を解決・キャッシュする。
// capability 解決（botCapabilities.ts）の後段フィルタとして使われ、メッセージ処理の
// ホットパスに乗るためインメモリキャッシュとし、設定変更時に無効化する。
//
// セマンティクス:
//   NULL（未設定）     → null を返す = 全モジュール有効（既存Bot・後方互換）
//   ["todo","finance"] → 該当ID集合を返す（selectable=false のモジュールは別途常に有効）
//   []                 → 空集合を返す = selectable モジュールは全てOFF（core のみ動作）

/** botId → 有効モジュールID集合（null = 全有効）。値が null の場合もキャッシュする */
const enabledModulesCache = new Map<string, ReadonlySet<string> | null>();

/** enabled_modules JSON をパースする（不正値は全有効=null へフォールバック） */
export function parseEnabledModules(
	json: string | null | undefined,
): ReadonlySet<string> | null {
	if (json == null) return null;
	try {
		const parsed = JSON.parse(json);
		if (Array.isArray(parsed)) {
			// 既知の selectable モジュールIDのみ採用（不明IDは無視）
			return new Set(
				parsed.map(String).filter((id) => isKnownSelectableModule(id)),
			);
		}
	} catch {}
	// パース不能は安全側に倒して全有効扱い
	return null;
}

/**
 * Botの有効モジュール集合をDBから解決する（インメモリキャッシュ付き）。
 * null = 全モジュール有効。不明なBot ID（system_default 等）も全有効として扱う。
 */
export function resolveBotEnabledModules(
	botId: string,
): ReadonlySet<string> | null {
	if (enabledModulesCache.has(botId)) {
		return enabledModulesCache.get(botId) ?? null;
	}
	const bot = getBotById(botId);
	const resolved = bot ? parseEnabledModules(bot.enabled_modules) : null;
	enabledModulesCache.set(botId, resolved);
	return resolved;
}

/** 設定変更・Bot削除時にキャッシュを無効化する（botId 省略時は全件） */
export function invalidateBotEnabledModulesCache(botId?: string): void {
	if (botId) {
		enabledModulesCache.delete(botId);
	} else {
		enabledModulesCache.clear();
	}
}
