import { getDb } from "./database.js";

/**
 * スキーマバージョン2（仕様書 v0.6.1 準拠）への全面再構築マイグレーション。
 *
 * データ分離の原則: ユーザーデータは全て user_id (DiscordユーザーID) を必須スコープとする。
 * 旧スキーマ（bot_id スコープ）のデータは破棄してよい方針のため、
 * バージョン不一致を検出した場合は旧テーブルを DROP して作り直す。
 */
const SCHEMA_VERSION = "2";

/** 旧スキーマ（v1）のテーブル群。v2移行時に破棄する */
const LEGACY_TABLES = [
  "users", "bots", "invite_codes", "tasks", "schedules", "expenses",
  "bot_calendar_access", "user_bot_access", "chat_history", "credentials",
  "playbooks", "bot_budget_limits", "expense_plans", "playbook_schedules",
  "playbook_runs", "bot_memories",
];

function getCurrentSchemaVersion(db: ReturnType<typeof getDb>): string {
  try {
    const row = db
      .prepare("SELECT value FROM system_settings WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return row?.value ?? "1";
  } catch {
    return "1"; // system_settings 自体が無い＝初回起動
  }
}

export async function runMigrations(): Promise<void> {
  const db = getDb();

  // system_settings テーブル（スキーマバージョン管理を兼ねるため最初に作成）
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  const currentVersion = getCurrentSchemaVersion(db);
  const hasLegacyUsers = (() => {
    try {
      const cols = db.pragma("table_info(users)") as { name: string }[];
      return cols.length > 0 && !cols.some((c) => c.name === "salt");
    } catch {
      return false;
    }
  })();

  // 旧テーブルが実在する場合のみ再構築を行う（新規DBでの誤解を招くログ・無駄なDROPを避ける）
  const hasAnyLegacyTable = (() => {
    try {
      const row = db
        .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'bots')")
        .get() as { count: number };
      return row.count > 0;
    } catch {
      return false;
    }
  })();

  if (currentVersion !== SCHEMA_VERSION && hasAnyLegacyTable && (currentVersion === "1" || hasLegacyUsers)) {
    console.log("⚠️ スキーマv1を検出しました。仕様v0.6.1スキーマ(v2)へ再構築します（旧データは破棄されます）...");
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of LEGACY_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DROP TABLE IF EXISTS message_logs_fts");
    db.exec("PRAGMA foreign_keys = ON");
  }

  // ─── ユーザー・認証（§5.3, §5.4） ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,             -- bcrypt (cost 12)
      salt TEXT NOT NULL,                      -- CSPRNG hex。ユーザー鍵導出(Argon2id)用
      role TEXT NOT NULL DEFAULT 'user',       -- 'user' | 'admin'
      -- ユーザー個別の Gemini API 設定（§4.2: ユーザー間共有不可）
      gemini_api_key_encrypted TEXT,
      gemini_api_key_iv TEXT,
      gemini_api_key_tag TEXT,
      gemini_model TEXT DEFAULT 'gemini-3.1-flash-lite',
      -- ユーザー個別の Google OAuth（§3.2.2, §8: カレンダー/Drive はユーザー毎）
      google_refresh_token_encrypted TEXT,
      google_refresh_token_iv TEXT,
      google_refresh_token_tag TEXT,
      google_calendar_id TEXT,
      google_calendars TEXT DEFAULT '[]',      -- JSON: 同期対象カレンダーIDリスト
      -- ユーザー設定
      rich_reply_enabled INTEGER NOT NULL DEFAULT 1,   -- §3.0.5
      remind_default_minutes INTEGER NOT NULL DEFAULT 10, -- §3.3.2 通知前時間デフォルト
      notify_target_type TEXT NOT NULL DEFAULT 'dm',  -- 'dm' | 'channel'
      notify_target_id TEXT,
      active_persona_id INTEGER,               -- §4.1 適用中ペルソナ
      timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
      -- バックアップ設定（§8: ユーザー個人のGoogle Driveへ）
      backup_enabled INTEGER NOT NULL DEFAULT 0,
      backup_interval_hours INTEGER NOT NULL DEFAULT 24, -- 最短1時間〜最長720時間(30日)
      backup_generations INTEGER NOT NULL DEFAULT 7,     -- 保持世代数
      backup_folder_id TEXT,
      backup_last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);

  // ─── Botインスタンス（§5.1）と共有（§5.2） ─────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,                   -- Bot作成者（オーナー）
      name TEXT NOT NULL,
      discord_token_encrypted TEXT,
      discord_token_iv TEXT,
      discord_token_tag TEXT,
      recommended_persona_id INTEGER,          -- §5.2: 推奨ペルソナ（is_public のみ可）
      discord_username TEXT,
      discord_avatar_url TEXT,
      suspended INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);

    CREATE TABLE IF NOT EXISTS bot_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,                  -- Bot作成者
      shared_user_id TEXT NOT NULL,            -- 招待されたユーザー
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'revoked'
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(bot_id, shared_user_id),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bot_shares_user ON bot_shares(shared_user_id, status);
  `);

  // ─── ペルソナ（§4.1） ────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',         -- 上限20,000文字（アプリ層で検証）
      is_public INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (owner_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_personas_owner ON personas(owner_id);
    CREATE INDEX IF NOT EXISTS idx_personas_public ON personas(is_public);
  `);

  // ─── 会話履歴の永続化（§7）+ 全文検索（§3.12） ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'system_default',
      discord_msg_id TEXT,
      role TEXT NOT NULL,                      -- 'user' | 'assistant'
      content TEXT NOT NULL,
      reply_to_msg_id TEXT,                    -- 返信元DiscordメッセージID（チェーン解決用）
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_message_logs_user ON message_logs(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_message_logs_discord_msg ON message_logs(discord_msg_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS message_logs_fts USING fts5(
      content,
      content='message_logs',
      content_rowid='id',
      tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS message_logs_ai AFTER INSERT ON message_logs BEGIN
      INSERT INTO message_logs_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS message_logs_ad AFTER DELETE ON message_logs BEGIN
      INSERT INTO message_logs_fts(message_logs_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS message_logs_au AFTER UPDATE ON message_logs BEGIN
      INSERT INTO message_logs_fts(message_logs_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO message_logs_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // ─── ToDo（§3.2） ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,                           -- ISO 8601 (日時または日付)
      priority TEXT,                           -- 'high' | 'medium' | 'low' | NULL (LLM自動付与)
      tags TEXT NOT NULL DEFAULT '[]',         -- JSON string[] (LLM自動付与)
      status TEXT NOT NULL DEFAULT 'open',     -- 'open' | 'done'
      linked_payment_id INTEGER,               -- 支払い予定との紐付け（§3.4）
      due_reminded INTEGER NOT NULL DEFAULT 0, -- 期限接近リマインド送信済みフラグ
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_todos_user_status ON todos(user_id, status);
  `);

  // ─── 予定（Googleカレンダー同期）（§3.2） ───────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT,
      remind_before_minutes INTEGER NOT NULL DEFAULT 10,
      reminded INTEGER NOT NULL DEFAULT 0,
      google_event_id TEXT,
      google_calendar_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_reminded ON schedules(reminded, start_at);
  `);

  // ─── リマインド（§3.3） ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      trigger_at TEXT NOT NULL,                -- 'YYYY-MM-DD HH:MM:SS'
      repeat_rule TEXT,                        -- cron式（繰り返しの場合）
      target_type TEXT NOT NULL DEFAULT 'dm',  -- 'dm' | 'channel'
      target_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'sent' | 'cancelled'
      source TEXT NOT NULL DEFAULT 'manual',   -- 'manual'|'todo'|'schedule'|'payment'|'birthday'|'webhook'
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, trigger_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, status);
  `);

  // ─── 家計（§3.4） ────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'expense',    -- 'income' | 'expense'
      amount INTEGER NOT NULL,                 -- 円単位
      category TEXT NOT NULL,
      memo TEXT,
      date TEXT NOT NULL,                      -- 'YYYY-MM-DD'
      time TEXT,
      source TEXT NOT NULL DEFAULT 'manual',   -- 'manual' | 'receipt_ocr'
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(user_id, category, date);

    CREATE TABLE IF NOT EXISTS budget_limits (
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      limit_amount INTEGER NOT NULL DEFAULT 50000,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, category),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS planned_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      memo TEXT,
      due_date TEXT NOT NULL,                  -- 'YYYY-MM-DD'
      repeat_rule TEXT,                        -- cron式（家賃・サブスク等の繰り返し）
      status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'settled' | 'cancelled'
      settled_expense_id INTEGER,
      linked_todo_id INTEGER,
      linked_reminder_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_planned_payments_user ON planned_payments(user_id, status, due_date);
  `);

  // ─── マクロ（Playbook）（§3.6） ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      keywords TEXT DEFAULT '[]',              -- JSON string[]
      description TEXT DEFAULT '',
      steps TEXT NOT NULL DEFAULT '',          -- Markdown手順 または Function Call列のJSON
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, name),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playbooks_user ON playbooks(user_id);

    CREATE TABLE IF NOT EXISTS playbook_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'system_default', -- 実行結果の通知に使うBot
      playbook_name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      description TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, playbook_name),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playbook_schedules_user ON playbook_schedules(user_id);

    CREATE TABLE IF NOT EXISTS playbook_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      playbook_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'success' | 'failed'
      output TEXT DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      FOREIGN KEY (schedule_id) REFERENCES playbook_schedules(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_user ON playbook_runs(user_id);
  `);

  // ─── コンテキストノート（§3.7）/ クリップボード（§3.10）/ 連絡先（§3.11） ─
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_notes (
      user_id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',        -- 上限10,000文字（アプリ層で検証）
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clipboard_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      expires_at TEXT,                         -- NULL = 無期限
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_clipboard_user ON clipboard_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_clipboard_expires ON clipboard_entries(expires_at);

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      birthday TEXT,                           -- 'YYYY-MM-DD' または '--MM-DD'（年不明）
      relationship TEXT,
      contact_info TEXT,
      notes TEXT,
      tags TEXT NOT NULL DEFAULT '[]',         -- JSON string[]
      birthday_reminded_year INTEGER,          -- 当年の誕生日リマインド生成済み判定
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
  `);

  // ─── パスワードマネージャ（§6: ユーザー鍵 Argon2id + AES-256-GCM） ───────
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      user_id TEXT NOT NULL,
      service_name TEXT NOT NULL,
      url TEXT,
      username TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, service_name),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
  `);

  // ─── 外部Webhook受信（§3.13） ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,              -- URLトークン（CSPRNG）
      secret_encrypted TEXT,                   -- HMAC検証用シークレット（暗号化保存）
      secret_iv TEXT,
      secret_tag TEXT,
      notify_target_type TEXT NOT NULL DEFAULT 'dm',
      notify_target_id TEXT,
      template TEXT,                           -- 通知テンプレート（任意）
      filter_keyword TEXT,                     -- 含まれる場合のみ通知（任意）
      create_todo INTEGER NOT NULL DEFAULT 0,
      create_reminder INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user ON webhook_endpoints(user_id);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received', -- 'received'|'notified'|'filtered'|'failed'
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
  `);

  // ─── 朝報（§3.9）/ 日報・週報（§3.8） ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS briefing_configs (
      user_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_cron TEXT NOT NULL DEFAULT '0 7 * * *',
      target_type TEXT NOT NULL DEFAULT 'dm',
      target_id TEXT,
      weather_lat REAL,
      weather_lng REAL,
      location_name TEXT,
      news_feeds TEXT NOT NULL DEFAULT '[]',   -- JSON string[] RSSフィードURL
      news_keywords TEXT NOT NULL DEFAULT '[]',-- JSON string[] キーワードフィルタ
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,                      -- 'daily' | 'weekly'
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_cron TEXT NOT NULL DEFAULT '0 21 * * *',
      target_type TEXT NOT NULL DEFAULT 'dm',
      target_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, type),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
  `);

  // ─── MCPサーバー拡張（§4.4） ─────────────────────────────────────────────
  // FKによりユーザー削除時に暗号化済み認証情報が孤児として残らないようにする
  // （user_id IS NULL のシステムレベル登録は CASCADE 対象外で保持される）
  const mcpFkMissing = (() => {
    try {
      const cols = db.pragma("table_info(mcp_servers)") as { name: string }[];
      if (cols.length === 0) return false; // 未作成（新規作成パスへ）
      const fks = db.pragma("foreign_key_list(mcp_servers)") as unknown[];
      return fks.length === 0;
    } catch {
      return false;
    }
  })();
  if (mcpFkMissing) {
    console.log("⚠️ mcp_servers にFKが無い旧定義を検出したため再作成します（登録済みMCPサーバーは再登録が必要です）");
    db.exec("DROP TABLE IF EXISTS mcp_servers");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,                            -- NULL = システムレベル登録（Adminのみ）
      name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      auth_credential_encrypted TEXT,
      auth_credential_iv TEXT,
      auth_credential_tag TEXT,
      tools_cache TEXT DEFAULT '[]',           -- tools/list の取得結果キャッシュ(JSON)
      tools_cache_updated TEXT,
      requires_confirmation INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_user ON mcp_servers(user_id);
  `);

  // ─── 監査ログ（§6.3.3, §5.3） ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,                    -- 例: 'credential.read', 'auth.login', 'admin.role_change'
      target TEXT,                             -- 対象（サービス名・ユーザーID等。秘密値は記録禁止）
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at);
  `);

  // ─── 招待コード（既存機能の継続） ────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT,
      used_by TEXT,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // スキーマバージョンを記録
  db.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')`
  ).run(SCHEMA_VERSION);

  console.log("✅ データベースマイグレーション完了 (schema v2)");
}
