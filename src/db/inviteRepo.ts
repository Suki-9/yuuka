import { getDb } from "./database.js";

export interface InviteCode {
  code: string;
  created_by: string | null;
  used_by: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * 招待コードを作成する
 */
export function createInviteCode(code: string, createdBy?: string): void {
  const db = getDb();
  // 既に存在する場合は無視する（起動時の重複投入防止）
  db.prepare(`
    INSERT OR IGNORE INTO invite_codes (code, created_by)
    VALUES (?, ?)
  `).run(code, createdBy ?? null);
}

/**
 * 未使用かつ無効化されていない有効な招待コードかどうか判定する
 */
export function isValidCode(code: string): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM invite_codes WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL LIMIT 1"
  ).get(code);
  return !!row;
}

/**
 * 招待コードを検証し、有効であれば消費する（1回使い切り。無効化済みは不可）
 */
export function validateAndConsumeCode(code: string, usedByDiscordId: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE invite_codes
    SET used_by = ?, used_at = datetime('now', 'localtime')
    WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL
  `).run(usedByDiscordId, code);
  return result.changes > 0;
}

/**
 * 未使用の招待コードを無効化する（記録は残す）。
 * 既に使用済み・無効化済みの場合は何もしない。
 * @returns 無効化に成功した場合 true
 */
export function revokeInviteCode(code: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE invite_codes
    SET revoked_at = datetime('now', 'localtime')
    WHERE code = ? AND used_by IS NULL AND revoked_at IS NULL
  `).run(code);
  return result.changes > 0;
}

/**
 * 未使用の招待コードを物理削除する。
 * 使用済みコードは監査のため削除できない。
 * @returns 削除に成功した場合 true
 */
export function deleteInviteCode(code: string): boolean {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM invite_codes WHERE code = ? AND used_by IS NULL"
  ).run(code);
  return result.changes > 0;
}

/**
 * 招待コード一覧を取得する（管理用）
 */
export function listInviteCodes(): InviteCode[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM invite_codes ORDER BY created_at DESC"
  ).all() as InviteCode[];
}

/**
 * config.yamlから初期招待コードをDBに投入する（未登録のもののみ）
 */
export function seedInitialCodes(codes: string[]): void {
  for (const code of codes) {
    if (code && code.trim()) {
      createInviteCode(code.trim());
    }
  }
}
