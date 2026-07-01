// deviceApi — user-scoped（scope:'user'）。
// device-management（deviceMgmtRoutes.ts）+ device-auth 承認（deviceAuthRoutes.ts）。
//
// ★重要: /api/auth/device/* と device-management 3本は botId を「絶対に付けない」
//   （§10.1。stale な botId を混ぜない）。OAuth トークンポーリング（pollToken）は
//   エンベロープ外の専用実装（../device.ts）を再輸出する。
import { api } from "../client";
import { requestDeviceCode, pollToken } from "../device";
import type { DevicesResponse, ApiResponse } from "../types";

const USER = { scope: "user" } as const;

export const deviceApi = {
	// ── デバイス管理 ──
	/** GET /api/devices — 登録済みデバイス一覧 */
	list: () => api.get<DevicesResponse>("/api/devices", USER),
	/** POST /api/devices/revoke — デバイス失効 */
	revoke: (deviceId: string) =>
		api.post<ApiResponse>("/api/devices/revoke", { deviceId }, USER),

	// ── デバイス認可（ブラウザ側の承認操作） ──
	/** POST /api/auth/device/approve — user_code をログイン済み本人が承認 */
	approve: (userCode: string) =>
		api.post<ApiResponse & { device_name?: string }>(
			"/api/auth/device/approve",
			{ user_code: userCode },
			USER,
		),

	// ── OAuth device flow（エンベロープ外・専用実装を再輸出。§10.4） ──
	/** POST /api/auth/device/code — デバイスコード発行 */
	requestDeviceCode,
	/** POST /api/auth/device/token — トークンポーリング（OAuth 形状） */
	pollToken,
};
