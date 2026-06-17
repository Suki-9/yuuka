import { getDb } from "./database.js";
import { encryptText } from "../utils/crypto.js";

// ─── Google 複数アカウント連携（v5） ─────────────────────────────────────────
// owner（user_id）単位で複数の Google アカウントを連携でき、Botごとに使うアカウントを選ぶ。
// リフレッシュトークンは既存(users.google_*)と同じ「システム鍵」で暗号化する。

export interface UserGoogleAccount {
  id: number;
  user_id: string;
  email: string | null;
  refresh_token_encrypted: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  calendar_id: string | null;
  calendars: string; // JSON string[]
  is_primary: number;
  created_at: string;
  updated_at: string;
}

/** UIに返す安全なビュー（トークン列を除く）。 */
export interface UserGoogleAccountSafe {
  id: number;
  email: string | null;
  calendar_id: string | null;
  calendars: string[];
  is_primary: boolean;
}

function toSafe(a: UserGoogleAccount): UserGoogleAccountSafe {
  let calendars: string[] = [];
  try {
    const parsed = JSON.parse(a.calendars || "[]");
    if (Array.isArray(parsed)) calendars = parsed;
  } catch {
    /* ignore */
  }
  return {
    id: a.id,
    email: a.email,
    calendar_id: a.calendar_id,
    calendars,
    is_primary: a.is_primary === 1,
  };
}

/**
 * Googleアカウントを追加する（OAuthコールバックから）。同一 (user_id, email) は更新（トークン差し替え）。
 * owner の最初のアカウントは自動的に primary になる。
 */
export function addGoogleAccount(
  userId: string,
  input: {
    email: string | null;
    refreshToken: string;
    calendarId?: string | null;
  }
): UserGoogleAccount {
  const db = getDb();
  const enc = encryptText(input.refreshToken);
  const hasAny = !!db
    .prepare("SELECT 1 FROM user_google_accounts WHERE user_id = ? LIMIT 1")
    .get(userId);
  const isPrimary = hasAny ? 0 : 1;

  // 既存 (user_id, email) があればトークンを更新、無ければ新規。email が NULL の場合は常に新規。
  const existing = input.email
    ? (db
        .prepare("SELECT * FROM user_google_accounts WHERE user_id = ? AND email = ?")
        .get(userId, input.email) as UserGoogleAccount | undefined)
    : undefined;

  if (existing) {
    db.prepare(
      `UPDATE user_google_accounts
         SET refresh_token_encrypted = ?, refresh_token_iv = ?, refresh_token_tag = ?,
             calendar_id = COALESCE(?, calendar_id), updated_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(enc.encrypted, enc.iv, enc.authTag, input.calendarId ?? null, existing.id);
    return getGoogleAccountById(existing.id)!;
  }

  const result = db
    .prepare(
      `INSERT INTO user_google_accounts
         (user_id, email, refresh_token_encrypted, refresh_token_iv, refresh_token_tag, calendar_id, is_primary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, input.email, enc.encrypted, enc.iv, enc.authTag, input.calendarId ?? null, isPrimary);
  return getGoogleAccountById(Number(result.lastInsertRowid))!;
}

export function getGoogleAccountById(id: number): UserGoogleAccount | undefined {
  return getDb().prepare("SELECT * FROM user_google_accounts WHERE id = ?").get(id) as
    | UserGoogleAccount
    | undefined;
}

/** owner の連携アカウント一覧（フル）。 */
export function listGoogleAccounts(userId: string): UserGoogleAccount[] {
  return getDb()
    .prepare("SELECT * FROM user_google_accounts WHERE user_id = ? ORDER BY is_primary DESC, id ASC")
    .all(userId) as UserGoogleAccount[];
}

/** owner の連携アカウント一覧（UI用・トークン無し）。 */
export function listGoogleAccountsSafe(userId: string): UserGoogleAccountSafe[] {
  return listGoogleAccounts(userId).map(toSafe);
}

/** owner の primary アカウント（バックアップ・秘書フォールバックで使用）。 */
export function getPrimaryGoogleAccount(userId: string): UserGoogleAccount | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM user_google_accounts WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1"
    )
    .get(userId) as UserGoogleAccount | undefined;
}

/** primary を付け替える（owner内で一意になるようトランザクションで他を解除）。 */
export function setPrimaryGoogleAccount(userId: string, accountId: number): boolean {
  const db = getDb();
  const acct = getGoogleAccountById(accountId);
  if (!acct || acct.user_id !== userId) return false;
  const tx = db.transaction(() => {
    db.prepare("UPDATE user_google_accounts SET is_primary = 0 WHERE user_id = ?").run(userId);
    db.prepare(
      "UPDATE user_google_accounts SET is_primary = 1, updated_at = datetime('now','localtime') WHERE id = ?"
    ).run(accountId);
  });
  tx();
  return true;
}

/** アカウントの同期対象カレンダーを更新する。 */
export function updateGoogleCalendars(accountId: number, calendars: string[]): void {
  getDb()
    .prepare(
      "UPDATE user_google_accounts SET calendars = ?, updated_at = datetime('now','localtime') WHERE id = ?"
    )
    .run(JSON.stringify(calendars), accountId);
}

/**
 * アカウントを削除する（owner本人のみ）。bot_google_account は FK CASCADE で消える。
 * 削除対象が primary だった場合は残りの最古を primary へ昇格する。
 */
export function deleteGoogleAccount(userId: string, accountId: number): boolean {
  const db = getDb();
  const acct = getGoogleAccountById(accountId);
  if (!acct || acct.user_id !== userId) return false;
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_google_accounts WHERE id = ?").run(accountId);
    if (acct.is_primary === 1) {
      const next = getDb()
        .prepare("SELECT id FROM user_google_accounts WHERE user_id = ? ORDER BY id ASC LIMIT 1")
        .get(userId) as { id: number } | undefined;
      if (next) {
        db.prepare("UPDATE user_google_accounts SET is_primary = 1 WHERE id = ?").run(next.id);
      }
    }
  });
  tx();
  return true;
}

// ─── Bot ごとの使用アカウント（bot_google_account） ─────────────────────────

/**
 * Botが使う Google アカウントを解決する（発話者 speakerUserId のコンテキストで）。
 *
 * セキュリティ（クロステナント防止）: 共有Bot（system_default 等、複数ユーザーが発話する）では、
 * Botに割り当てられた特定アカウントが「他人のGoogleトークン」を指していても、発話者がその所有者で
 * ない限り使用させない。割当アカウントは発話者自身が所有する場合に限り採用し、それ以外は発話者自身の
 * primary へフォールバックする（他人のカレンダー/Driveへ越権アクセスさせない）。
 *   行なし                          → 発話者の primary へフォールバック
 *   account_id NULL                 → 「連携なし」（undefined）
 *   account_id = N かつ Nの所有者=発話者 → アカウント N
 *   account_id = N かつ Nの所有者≠発話者 → 発話者の primary（越権防止）
 * @param speakerUserId 発話者（＝このトークンを使う主体）の discord_id
 */
export function getAccountForBot(botId: string, speakerUserId: string): UserGoogleAccount | undefined {
  const row = getDb()
    .prepare("SELECT google_account_id FROM bot_google_account WHERE bot_id = ?")
    .get(botId) as { google_account_id: number | null } | undefined;
  if (!row) return getPrimaryGoogleAccount(speakerUserId); // 未設定 → 発話者の primary
  if (row.google_account_id == null) return undefined; // 連携なし
  const acct = getGoogleAccountById(row.google_account_id);
  // 割当アカウントは発話者本人のものに限り使用する（他人のトークンを共有Bot経由で使わせない）
  if (acct && acct.user_id === speakerUserId) return acct;
  return getPrimaryGoogleAccount(speakerUserId);
}

/**
 * Botの使用アカウントを設定する。
 * accountId = number → そのアカウント、accountId = null → 「連携なし」。
 * （primaryフォールバックへ戻すには clearBotGoogleAccount を使う）
 */
export function setBotGoogleAccount(botId: string, accountId: number | null): void {
  getDb()
    .prepare(
      `INSERT INTO bot_google_account (bot_id, google_account_id) VALUES (?, ?)
       ON CONFLICT(bot_id) DO UPDATE SET google_account_id = excluded.google_account_id,
         created_at = datetime('now','localtime')`
    )
    .run(botId, accountId);
}

/** Botの使用アカウント割当を解除する（行削除＝primaryフォールバックに戻る）。 */
export function clearBotGoogleAccount(botId: string): void {
  getDb().prepare("DELETE FROM bot_google_account WHERE bot_id = ?").run(botId);
}

/** BotのGoogle使用設定モード（UI/オーバービュー用）。 */
export function getBotGoogleMode(botId: string): "primary" | "none" | number {
  const row = getDb()
    .prepare("SELECT google_account_id FROM bot_google_account WHERE bot_id = ?")
    .get(botId) as { google_account_id: number | null } | undefined;
  if (!row) return "primary"; // 未設定
  if (row.google_account_id == null) return "none"; // 連携なし
  return row.google_account_id;
}
