import { CronExpressionParser } from "cron-parser";
import type { RouteDef, RouteRequestCtx } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import * as reminderRepo from "../../db/reminderRepo.js";
import {
  parseDbDateTime,
  toDbDateTime,
  type ReminderTargetType,
} from "../../db/reminderRepo.js";
import { getUserNotifyTarget } from "../../db/userRepo.js";

// ─── リマインド HTTPルート（§3.3） ───────────────────────────────────────────
//
// Web UI 向けのリマインド一覧・登録・キャンセルAPI。
// 全ルート auth:"user"。リソースは必ず ctx.user.discordId でスコープする（§12）。
// ルートは server/routeRegistry.ts の registerRoutes() で統合フェーズに登録される。

// ─── ヘルパー ────────────────────────────────────────────────────────────────

/** リクエストボディから空でない文字列を取り出す（無ければ undefined） */
function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 送信先タイプの検証（'dm' | 'channel' 以外は undefined） */
function asOptionalTarget(value: unknown): ReminderTargetType | undefined {
  if (value === "dm" || value === "channel") return value;
  return undefined;
}

// ─── ルート定義 ──────────────────────────────────────────────────────────────

export const reminderRoutes: RouteDef[] = [
  // ── リマインド一覧（?all=1 で送信済み・キャンセル済みも含める） ──
  {
    method: "GET",
    path: "/api/reminders",
    auth: "user",
    async handler(ctx: RouteRequestCtx): Promise<void> {
      if (!ctx.user) {
        sendJson(ctx.res, 401, { success: false, message: "認証が必要です" });
        return;
      }
      const allParam = ctx.url.searchParams.get("all");
      const includeAll = allParam === "1" || allParam === "true";
      const reminders = reminderRepo.listReminders(ctx.user.discordId, includeAll);
      sendJson(ctx.res, 200, { success: true, reminders });
    },
  },

  // ── リマインド登録 ──
  {
    method: "POST",
    path: "/api/reminders/add",
    auth: "user",
    async handler(ctx: RouteRequestCtx): Promise<void> {
      if (!ctx.user) {
        sendJson(ctx.res, 401, { success: false, message: "認証が必要です" });
        return;
      }

      const message = asOptionalString(ctx.body.message);
      if (!message) {
        sendJson(ctx.res, 400, { success: false, message: "message を指定してください" });
        return;
      }

      const triggerAtArg = asOptionalString(ctx.body.trigger_at);
      if (!triggerAtArg) {
        sendJson(ctx.res, 400, {
          success: false,
          message: "trigger_at (ISO 8601 / YYYY-MM-DD HH:MM:SS) を指定してください",
        });
        return;
      }

      // 日時をDB既存形式 'YYYY-MM-DD HH:MM:SS'（ローカルタイム）へ正規化する
      let triggerAt: string;
      try {
        triggerAt = toDbDateTime(triggerAtArg);
      } catch {
        sendJson(ctx.res, 400, {
          success: false,
          message: `trigger_at を日時として解釈できません: ${triggerAtArg}`,
        });
        return;
      }

      // 繰り返しの場合は cron式の妥当性を登録時に検証する（§3.3.2）
      const repeatRule = asOptionalString(ctx.body.repeat_rule);
      if (repeatRule) {
        try {
          CronExpressionParser.parse(repeatRule, { currentDate: new Date() });
        } catch {
          sendJson(ctx.res, 400, {
            success: false,
            message: `repeat_rule のcron式が不正です: ${repeatRule}（例: 毎週月曜9時 = '0 9 * * 1'）`,
          });
          return;
        }
      }

      // 過去日時の検査（1分の猶予あり）。繰り返しならcron式から次回時刻へ自動補正する
      if (parseDbDateTime(triggerAt).getTime() < Date.now() - 60_000) {
        if (repeatRule) {
          const next = CronExpressionParser.parse(repeatRule, { currentDate: new Date() })
            .next()
            .toDate();
          triggerAt = toDbDateTime(next);
        } else {
          sendJson(ctx.res, 400, {
            success: false,
            message: `trigger_at が過去の日時です: ${triggerAtArg}（未来の日時を指定してください）`,
          });
          return;
        }
      }

      // 送信先: 明示指定が無ければユーザー設定の既定送信先（users.notify_target_*）に従う（§3.3.2）
      let targetType = asOptionalTarget(ctx.body.target_type);
      let targetId = asOptionalString(ctx.body.target_id);
      if (!targetType) {
        const pref = getUserNotifyTarget(ctx.user.discordId);
        targetType = pref?.type ?? "dm";
        targetId = targetId ?? pref?.id;
      }

      const reminder = reminderRepo.addReminder(ctx.user.discordId, {
        message,
        triggerAt,
        repeatRule,
        targetType,
        targetId,
        source: "manual",
      });

      sendJson(ctx.res, 200, { success: true, reminder });
    },
  },

  // ── リマインドのキャンセル ──
  {
    method: "POST",
    path: "/api/reminders/cancel",
    auth: "user",
    async handler(ctx: RouteRequestCtx): Promise<void> {
      if (!ctx.user) {
        sendJson(ctx.res, 401, { success: false, message: "認証が必要です" });
        return;
      }

      const reminderId = Number(ctx.body.reminder_id);
      if (!Number.isInteger(reminderId) || reminderId <= 0) {
        sendJson(ctx.res, 400, {
          success: false,
          message: "reminder_id を正の整数で指定してください",
        });
        return;
      }

      const cancelled = reminderRepo.cancelReminder(ctx.user.discordId, reminderId);
      if (!cancelled) {
        // 失敗理由を区別して返す（存在しない / 既に送信済み・キャンセル済み）
        const existing = reminderRepo.getReminderById(ctx.user.discordId, reminderId);
        if (!existing) {
          sendJson(ctx.res, 404, {
            success: false,
            message: `リマインド #${reminderId} が見つかりません`,
          });
          return;
        }
        sendJson(ctx.res, 409, {
          success: false,
          message: `リマインド #${reminderId} は status='${existing.status}' のためキャンセルできません`,
        });
        return;
      }

      sendJson(ctx.res, 200, { success: true, reminder: cancelled });
    },
  },
];
