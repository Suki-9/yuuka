import { getDb } from "./database.js";

/** 既存DBに後発カラムを安全に追加する（既に存在する場合は無視する） */
function addColumnIfMissing(
  db: ReturnType<typeof getDb>,
  table: string,
  columnDef: string
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (_) {
    // カラムが既に存在する場合は無視
  }
}

export async function runMigrations(): Promise<void> {
  const db = getDb();

  // users テーブルの作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      gemini_api_key_encrypted TEXT,
      gemini_api_key_iv TEXT,
      gemini_api_key_tag TEXT,
      gemini_model TEXT DEFAULT 'gemini-3.1-flash-lite',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
  `);

  // 既存のDB環境向けの後発カラム追加（既に存在する場合は無視）
  addColumnIfMissing(db, "bots", "memories TEXT");
  addColumnIfMissing(db, "users", "gemini_api_key_encrypted TEXT");
  addColumnIfMissing(db, "users", "gemini_api_key_iv TEXT");
  addColumnIfMissing(db, "users", "gemini_api_key_tag TEXT");
  addColumnIfMissing(db, "users", "gemini_model TEXT DEFAULT 'gemini-3.1-flash-lite'");

  // bots テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      discord_token_encrypted TEXT,
      discord_token_iv TEXT,
      discord_token_tag TEXT,
      persona TEXT,
      gemini_api_key_encrypted TEXT,
      gemini_api_key_iv TEXT,
      gemini_api_key_tag TEXT,
      gemini_model TEXT DEFAULT 'gemini-3.1-flash-lite',
      google_client_id TEXT,
      google_client_secret TEXT,
      google_refresh_token TEXT,
      google_calendar_id TEXT,
      google_calendars TEXT,
      google_drive_backup_enabled INTEGER DEFAULT 0,
      google_drive_backup_folder_id TEXT,
      backup_cron TEXT DEFAULT '0 3 * * *',
      discord_username TEXT,
      discord_avatar_url TEXT,
      suspended INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bots_user ON bots(user_id);
  `);

  // invite_codes テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT,
      used_by TEXT,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (used_by) REFERENCES users(discord_id)
    );
  `);

  // tasks テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_bot_status ON tasks(bot_id, status);
  `);

  // schedules テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT,
      remind_before_minutes INTEGER NOT NULL DEFAULT 30,
      reminded INTEGER NOT NULL DEFAULT 0,
      google_event_id TEXT,
      google_calendar_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedules_bot ON schedules(bot_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_start ON schedules(start_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_reminded ON schedules(reminded, start_at);
  `);

  // expenses テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      time TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_bot_date ON expenses(bot_id, date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(bot_id, category, date);
  `);

  // bot_calendar_access テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_calendar_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
  `);

  // user_bot_access テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_bot_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (user_id) REFERENCES users(discord_id) ON DELETE CASCADE,
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
      UNIQUE(user_id, bot_id)
    );
  `);

  // chat_history テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_history_bot ON chat_history(bot_id);
  `);

  // credentials テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      bot_id TEXT NOT NULL DEFAULT '',
      service_name TEXT NOT NULL,
      username TEXT NOT NULL,
      encrypted_password TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (bot_id, service_name),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_credentials_bot ON credentials(bot_id);
  `);

  // playbooks テーブル作成
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT NOT NULL,
      keywords TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      steps TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      UNIQUE(bot_id, name),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_playbooks_bot ON playbooks(bot_id);
  `);

  // bot_budget_limits テーブル作成（カテゴリ別予算上限）
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_budget_limits (
      bot_id TEXT NOT NULL,
      category TEXT NOT NULL,
      limit_amount INTEGER NOT NULL DEFAULT 50000,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (bot_id, category),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
  `);

  // expense_plans テーブル作成（支払い予定）
  db.exec(`
    CREATE TABLE IF NOT EXISTS expense_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      amount INTEGER NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      planned_date TEXT NOT NULL,
      is_paid INTEGER NOT NULL DEFAULT 0,
      paid_expense_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_expense_plans_bot ON expense_plans(bot_id, planned_date);
  `);

  // playbook_schedules テーブル作成（定期実行スケジュール）
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      playbook_name TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      description TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playbook_schedules_bot ON playbook_schedules(bot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_schedules_bot_playbook ON playbook_schedules(bot_id, playbook_name);
  `);

  // playbook_runs テーブル作成（実行履歴）
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      playbook_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      output TEXT DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      FOREIGN KEY (schedule_id) REFERENCES playbook_schedules(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_schedule ON playbook_runs(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_playbook_runs_bot ON playbook_runs(bot_id);
  `);

  // bot_memories テーブル作成（記憶・メモ）
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_bot_memories_bot ON bot_memories(bot_id);
  `);

  // 旧記憶データの移行（存在する場合）
  try {
    const columnsInfo = db.pragma("table_info(bots)") as { name: string }[];
    const hasMemoriesColumn = columnsInfo.some(c => c.name === "memories");
    if (hasMemoriesColumn) {
      const botsWithMemories = db.prepare("SELECT id, memories FROM bots WHERE memories IS NOT NULL AND memories != ''").all() as { id: string, memories: string }[];
      for (const bot of botsWithMemories) {
        const lines = bot.memories
          .split(/\r?\n/)
          .map(line => line.replace(/^-\s*/, "").trim())
          .filter(line => line.length > 0);
        
        const insertStmt = db.prepare("INSERT INTO bot_memories (bot_id, content) VALUES (?, ?)");
        for (const line of lines) {
          insertStmt.run(bot.id, line);
        }
        // 移行が終わったらNULLクリアする
        db.prepare("UPDATE bots SET memories = NULL WHERE id = ?").run(bot.id);
      }
    }
  } catch (err) {
    console.error("旧記憶データの移行中にエラーが発生しました:", err);
  }

  console.log("✅ データベースマイグレーション完了");
}
