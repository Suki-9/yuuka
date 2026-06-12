import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import * as secretService from "../../services/secretService.js";

// ─── パスワードマネージャ HTTPルート（§6: ユーザー鍵暗号化） ──────────────────
// 監査ログは secretService 層で記録される（二重記録しない）。

export const credentialRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/api/credentials",
    auth: "user",
    async handler(ctx) {
      const list = secretService.listCredentialServices(ctx.user!.discordId);
      sendJson(ctx.res, 200, { success: true, credentials: list });
    },
  },
  {
    method: "POST",
    path: "/api/credentials/register",
    auth: "user",
    async handler(ctx) {
      const { serviceName, username, password, url } = ctx.body as Record<string, string>;
      if (!serviceName || !username || !password) {
        return sendJson(ctx.res, 400, { success: false, message: "サービス名、ユーザー名、およびパスワードは必須です。" });
      }
      try {
        secretService.registerCredential(ctx.user!.discordId, serviceName, username, password, url || undefined);
        sendJson(ctx.res, 200, { success: true, message: "資格情報を正常に登録しました。" });
      } catch (err) {
        sendJson(ctx.res, 400, { success: false, message: (err as Error).message || "資格情報の登録に失敗しました。" });
      }
    },
  },
  {
    method: "POST",
    path: "/api/credentials/delete",
    auth: "user",
    async handler(ctx) {
      const { serviceName } = ctx.body as Record<string, string>;
      if (!serviceName) {
        return sendJson(ctx.res, 400, { success: false, message: "サービス名は必須です。" });
      }
      const success = secretService.deleteCredential(ctx.user!.discordId, serviceName);
      sendJson(ctx.res, 200, { success });
    },
  },
];
