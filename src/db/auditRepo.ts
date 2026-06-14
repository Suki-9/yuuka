import { getDb } from "./database.js";

export interface AuditLogRecord {
  id: number;
  user_id: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: string;
}

/**
 * 監査ログを記録する（§6.3.3, §5.3.2）
 * 注意: パスワード本体・APIキー等の秘密値を target / detail に含めてはならない。
 *
 * action の命名例:
 *   credential.read / credential.write / credential.delete
 *   auth.login / auth.login_failed / auth.register / auth.password_change
 *   admin.role_change / admin.bot_suspend / admin.invite_create / admin.backup_run
 *   webhook.received / mcp.call
 */
export function addAuditLog(
  userId: string,
  action: string,
  target?: string,
  detail?: string
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO audit_logs (user_id, action, target, detail) VALUES (?, ?, ?, ?)"
  ).run(userId, action, target ?? null, detail ?? null);
}

/** 監査ログの一覧取得（Admin専用画面用、ページネーション対応） */
export function listAuditLogs(
  limit: number = 200,
  action?: string,
  offset: number = 0
): AuditLogRecord[] {
  const db = getDb();
  if (action) {
    return db
      .prepare("SELECT * FROM audit_logs WHERE action LIKE ? ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(`${action}%`, limit, offset) as AuditLogRecord[];
  }
  return db
    .prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as AuditLogRecord[];
}

/** 監査ログの総件数（ページネーションの総ページ算出用） */
export function countAuditLogs(action?: string): number {
  const db = getDb();
  if (action) {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE ?")
      .get(`${action}%`) as { c: number };
    return row.c;
  }
  const row = db.prepare("SELECT COUNT(*) AS c FROM audit_logs").get() as { c: number };
  return row.c;
}
