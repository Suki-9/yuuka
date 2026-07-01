// 型付き API クライアント層のエントリポイント（§10）。
//
// 使い方:
//   import { taskApi, api, ApiError } from "$lib/api";
//   import type { TodoWithSubtasks } from "$lib/api";
//
// - 汎用クライアント: api.get / api.post / api.del（scope 必須）+ ApiError
// - 領域別サービス: authApi / botApi / taskApi / … / deviceApi
// - 型: types.ts の全エクスポート
// - デバイス OAuth: pollToken / requestDeviceCode（エンベロープ外・§10.4）

export { api, ApiError } from "./client";
export type { Scope, RequestOpts, NoBodyOpts } from "./client";

export * from "./services";
export * from "./types";

export { pollToken, requestDeviceCode } from "./device";
