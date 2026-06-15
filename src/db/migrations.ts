import { getDb } from "./database.js";

/**
 * スキーマバージョン2（仕様書 v0.6.1 準拠）への全面再構築マイグレーション。
 *
 * データ分離の原則: ユーザーデータは全て user_id (DiscordユーザーID) を必須スコープとする。
 * 旧スキーマ（bot_id スコープ）のデータは破棄してよい方針のため、
 * バージョン不一致を検出した場合は旧テーブルを DROP して作り直す。
 */
const SCHEMA_VERSION = "3";

/** 旧スキーマ（v1）のテーブル群。v2移行時に破棄する */
const LEGACY_TABLES = [
  "users", "bots", "invite_codes", "tasks", "schedules", "expenses",
  "bot_calendar_access", "user_bot_access", "chat_history", "credentials",
  "playbooks", "bot_budget_limits", "expense_plans", "playbook_schedules",
  "playbook_runs", "bot_memories",
];

/**
 * 既存テーブルへ後付け列を追加する（冪等）。
 * テーブルが未作成の場合は何もしない（CREATE TABLE 側の定義に列が含まれる前提）。
 */
function ensureColumns(
  db: ReturnType<typeof getDb>,
  table: string,
  defs: Array<{ name: string; ddl: string }>
): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (cols.length === 0) return;
  for (const def of defs) {
    if (!cols.some((c) => c.name === def.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${def.ddl}`);
      console.log(`🔧 ${table} へ列を追加しました: ${def.name}`);
    }
  }
}

/** テーブルに指定列が存在するか（テーブル未作成なら false）。 */
function hasColumn(db: ReturnType<typeof getDb>, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  return cols.some((c) => c.name === column);
}

/**
 * v3: 秘書業務データを (user_id, bot_id) スコープへ移行する（冪等）。
 * - 一意制約に user_id を含まないテーブル: bot_id 列を後付けするだけ（既存行は DEFAULT 'system_default'）。
 * - PK/UNIQUE に user_id を含むテーブル: bot_id を含む制約へ作り直す（既存DBのみ・bot_id 欠落時）。
 */
function migrateToBotScopedData(db: ReturnType<typeof getDb>): void {
  // 列追加のみで済むテーブル（id PK・user_id 一意制約なし）
  const SIMPLE_TABLES = [
    "todos", "schedules", "reminders", "expenses", "planned_payments",
    "playbook_runs", "clipboard_entries", "contacts",
  ];
  for (const t of SIMPLE_TABLES) {
    ensureColumns(db, t, [{ name: "bot_id", ddl: "bot_id TEXT NOT NULL DEFAULT 'system_default'" }]);
  }

  // 一意制約に user_id を含むため再構築が必要なテーブル。
  // 新しい CREATE TABLE 定義は既に bot_id を含むため、新規DBでは bot_id が存在し再構築はスキップされる。
  const REBUILDS: Array<{ table: string; createRebuilt: string; columns: string; indexes?: string }> = [
    {
      table: "budget_limits",
      createRebuilt: `CREATE TABLE budget_limits_rebuilt (
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'system_default',
        category TEXT NOT NULL,
        limit_amount INTEGER NOT NULL DEFAULT 50000,
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (user_id, bot_id, category),
        FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
      )`,
      columns: "user_id, bot_id, category, limit_amount, updated_at",
    },
    {
      table: "context_notes",
      createRebuilt: `CREATE TABLE context_notes_rebuilt (
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'system_default',
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (user_id, bot_id),
        FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
      )`,
      columns: "user_id, bot_id, content, updated_at",
    },
    {
      table: "briefing_configs",
      createRebuilt: `CREATE TABLE briefing_configs_rebuilt (
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'system_default',
        enabled INTEGER NOT NULL DEFAULT 0,
        schedule_cron TEXT NOT NULL DEFAULT '0 7 * * *',
        target_type TEXT NOT NULL DEFAULT 'dm',
        target_id TEXT,
        weather_lat REAL,
        weather_lng REAL,
        location_name TEXT,
        news_feeds TEXT NOT NULL DEFAULT '[]',
        news_keywords TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (user_id, bot_id),
        FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
      )`,
      columns: "user_id, bot_id, enabled, schedule_cron, target_type, target_id, weather_lat, weather_lng, location_name, news_feeds, news_keywords, updated_at",
    },
    {
      table: "report_configs",
      createRebuilt: `CREATE TABLE report_configs_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'system_default',
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        schedule_cron TEXT NOT NULL DEFAULT '0 21 * * *',
        target_type TEXT NOT NULL DEFAULT 'dm',
        target_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, bot_id, type),
        FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
      )`,
      columns: "id, user_id, bot_id, type, enabled, schedule_cron, target_type, target_id, updated_at",
    },
    {
      table: "playbooks",
      createRebuilt: `CREATE TABLE playbooks_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'system_default',
        name TEXT NOT NULL,
        title TEXT NOT NULL,
        keywords TEXT DEFAULT '[]',
        description TEXT DEFAULT '',
        steps TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(user_id, bot_id, name),
        FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
      )`,
      columns: "id, user_id, name, title, keywords, description, steps, created_at, updated_at",
      indexes: "CREATE INDEX IF NOT EXISTS idx_playbooks_user ON playbooks(user_id);",
    },
  ];

  for (const r of REBUILDS) {
    // テーブル未作成（新規DB直後は CREATE 済みなので存在する）または既に bot_id 列があるなら何もしない
    const exists = (db.pragma(`table_info(${r.table})`) as { name: string }[]).length > 0;
    if (!exists || hasColumn(db, r.table, "bot_id")) continue;

    console.log(`🔧 ${r.table} を再構築しています（bot_id スコープ化）...`);
    db.exec("PRAGMA foreign_keys = OFF");
    // columns は旧テーブル側の列名。bot_id を含まない場合は SELECT で 'system_default' を補う。
    const selectCols = r.columns
      .split(",")
      .map((c) => c.trim())
      .map((c) => (c === "bot_id" ? "'system_default' AS bot_id" : c))
      .join(", ");
    db.exec(`
      ${r.createRebuilt};
      INSERT INTO ${r.table}_rebuilt (${r.columns}) SELECT ${selectCols} FROM ${r.table};
      DROP TABLE ${r.table};
      ALTER TABLE ${r.table}_rebuilt RENAME TO ${r.table};
      ${r.indexes ?? ""}
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }
}

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

  // ─── Botインスタンス（§5.1）と共有（§5.2）、Bot属性（bot_attributes_requirements.md §5） ─
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
      -- Bot属性（要件 §3: ケーパビリティ集合。core は全Bot必須のため記載しない）
      capabilities TEXT NOT NULL DEFAULT '["persona","memory","mcp","secretary"]',
      persona_id INTEGER,                      -- 要件 §4.4: Bot単位ペルソナ（汎用モード用）
      -- 要件 §4.3.3: Bot専用Gemini APIキー（システム鍵で暗号化。汎用モードでは設定必須）
      gemini_api_key_encrypted TEXT,
      gemini_api_key_iv TEXT,
      gemini_api_key_tag TEXT,
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

  // 既存DBの bots へ属性列を後付け（既存行はDEFAULTにより秘書相当の capabilities が付与され、
  // 動作・プロンプト・Functionセットは現行と完全に一致する。要件 §7 後方互換）
  ensureColumns(db, "bots", [
    { name: "capabilities", ddl: `capabilities TEXT NOT NULL DEFAULT '["persona","memory","mcp","secretary"]'` },
    { name: "persona_id", ddl: "persona_id INTEGER" },
    { name: "gemini_api_key_encrypted", ddl: "gemini_api_key_encrypted TEXT" },
    { name: "gemini_api_key_iv", ddl: "gemini_api_key_iv TEXT" },
    { name: "gemini_api_key_tag", ddl: "gemini_api_key_tag TEXT" },
  ]);

  // ─── Bot属性 関連テーブル（bot_attributes_requirements.md §5） ──────────────
  db.exec(`
    -- BotとMCPサーバーの紐付け（要件 §4.5: owner所有サーバーのみ。検証はアプリ層）
    CREATE TABLE IF NOT EXISTS bot_mcp_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      mcp_server_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(bot_id, mcp_server_id),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
      FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bot_mcp_links_bot ON bot_mcp_links(bot_id);

    -- 個人ノート（要件 §4.6.2: bot_id × ユーザー単位。context_notes は秘書用に現状維持）
    -- データ分離原則（architecture_v2.md §0-1）の正式な例外パターン: bot_id × user_id 複合スコープ。
    -- user_id はWebアカウント未登録のDiscordユーザーIDも可のため users へのFKは張らない。
    CREATE TABLE IF NOT EXISTS bot_context_notes (
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (bot_id, user_id),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    -- ギルド共有ノート（要件 §4.6.2: bot_id × ギルド単位）
    CREATE TABLE IF NOT EXISTS bot_guild_notes (
      bot_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (bot_id, guild_id),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    -- 応答許可ギルド（要件 §4.3.3 / §6: 未許可ギルドでは応答も記録もしない防衛線）
    CREATE TABLE IF NOT EXISTS bot_guilds (
      bot_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (bot_id, guild_id),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    -- 利用メンバー（要件 §4.3.3: DiscordユーザーIDのみで管理。Webアカウント不要）
    CREATE TABLE IF NOT EXISTS bot_members (
      bot_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (bot_id, guild_id, user_id),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
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
  // 注意: user_id に users への FK は張らない。汎用モード（Bot属性要件 §4.3.3 / §6）では
  // Webアカウント未登録のDiscordユーザー（利用メンバー）の発話も記録するため。
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'system_default',
      discord_msg_id TEXT,
      role TEXT NOT NULL,                      -- 'user' | 'assistant'
      content TEXT NOT NULL,
      reply_to_msg_id TEXT,                    -- 返信元DiscordメッセージID（チェーン解決用）
      guild_id TEXT,                           -- 発話ギルド（NULL = DM・秘書利用。要件 §4.6.1）
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // 既存DBの message_logs へ guild_id 列を後付け（要件 §5）
  ensureColumns(db, "message_logs", [{ name: "guild_id", ddl: "guild_id TEXT" }]);

  // 既存DBに users へのFK付き旧定義が残っている場合は、FKを撤廃する再構築を行う
  // （未登録メンバーの発話が FOREIGN KEY constraint failed で記録できないため）。
  // id を明示コピーするため FTS（外部コンテンツ表）の rowid 整合は保たれる。
  const messageLogsFkRemains = (() => {
    try {
      return (db.pragma("foreign_key_list(message_logs)") as unknown[]).length > 0;
    } catch {
      return false;
    }
  })();
  if (messageLogsFkRemains) {
    console.log("🔧 message_logs を再構築しています（未登録メンバー記録のためFKを撤廃）...");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      DROP TRIGGER IF EXISTS message_logs_ai;
      DROP TRIGGER IF EXISTS message_logs_ad;
      DROP TRIGGER IF EXISTS message_logs_au;
      CREATE TABLE message_logs_rebuilt (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        bot_id TEXT NOT NULL DEFAULT 'system_default',
        discord_msg_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to_msg_id TEXT,
        guild_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      INSERT INTO message_logs_rebuilt (id, user_id, bot_id, discord_msg_id, role, content, reply_to_msg_id, guild_id, created_at)
        SELECT id, user_id, bot_id, discord_msg_id, role, content, reply_to_msg_id, guild_id, created_at FROM message_logs;
      DROP TABLE message_logs;
      ALTER TABLE message_logs_rebuilt RENAME TO message_logs;
    `);
    db.exec("PRAGMA foreign_keys = ON");
  }

  // インデックス・FTS・トリガーは再構築後に作成する（IF NOT EXISTS のため新規・既存とも安全）
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_logs_user ON message_logs(user_id, id);
    CREATE INDEX IF NOT EXISTS idx_message_logs_discord_msg ON message_logs(discord_msg_id);
    CREATE INDEX IF NOT EXISTS idx_message_logs_bot_guild ON message_logs(bot_id, guild_id, id);

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
      bot_id TEXT NOT NULL DEFAULT 'system_default',
      category TEXT NOT NULL,
      limit_amount INTEGER NOT NULL DEFAULT 50000,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, bot_id, category),
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
      bot_id TEXT NOT NULL DEFAULT 'system_default',
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      keywords TEXT DEFAULT '[]',              -- JSON string[]
      description TEXT DEFAULT '',
      steps TEXT NOT NULL DEFAULT '',          -- Markdown手順 または Function Call列のJSON
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, bot_id, name),
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
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'system_default',
      content TEXT NOT NULL DEFAULT '',        -- 上限10,000文字（アプリ層で検証）
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (user_id, bot_id),
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
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'system_default',
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
      PRIMARY KEY (user_id, bot_id),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL DEFAULT 'system_default',
      type TEXT NOT NULL,                      -- 'daily' | 'weekly'
      enabled INTEGER NOT NULL DEFAULT 0,
      schedule_cron TEXT NOT NULL DEFAULT '0 21 * * *',
      target_type TEXT NOT NULL DEFAULT 'dm',
      target_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(user_id, bot_id, type),
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
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  ensureColumns(db, "invite_codes", [{ name: "revoked_at", ddl: "revoked_at TEXT" }]);

  // ─── v3: 秘書業務データのBot別分離（user_id → (user_id, bot_id)） ──────────
  // 既存行は bot_id = 'system_default'（早瀬ユウカ）に帰属させる。
  // 一意制約を含まないテーブルは列追加のみ。PK/UNIQUE に user_id を含むテーブルは再構築する。
  migrateToBotScopedData(db);

  // スキーマバージョンを記録
  db.prepare(
    `INSERT INTO system_settings (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', 'localtime')`
  ).run(SCHEMA_VERSION);

  console.log(`✅ データベースマイグレーション完了 (schema v${SCHEMA_VERSION})`);
}
