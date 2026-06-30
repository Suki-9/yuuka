// ─── 機能モジュール統合層（ファサード） ─────────────────────────────────────
//
// 機能モジュールのカタログと解決ロジックは moduleCatalog.ts に集約されている。
// 個別モジュール（browser / richContent）はそれぞれ専用ファイルへ分離した。
// 既存の import パス（"./functions/index.js"）を維持するため、ここで再エクスポートする。

export { browserModule } from "./browserModule.js";
export type { ModuleCatalogEntry } from "./moduleCatalog.js";
export {
	getBaseFunctionModules,
	getFunctionModulesForCapabilities,
	getGuildAssistantFunctionModules,
	isKnownSelectableModule,
	listSelectableModules,
} from "./moduleCatalog.js";
export { richContentModule } from "./richContentModule.js";
