import { getDb } from "./database.js";

/**
 * Get a system setting value by key.
 * If the setting is not found or fails, returns the defaultValue.
 */
export function getSystemSetting(key: string, defaultValue: string = ""): string {
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : defaultValue;
  } catch (err) {
    console.error(`Error getting system setting ${key}:`, err);
    return defaultValue;
  }
}

/**
 * Set a system setting value.
 * Upserts the setting in the database.
 */
export function setSystemSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO system_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
  `).run(key, value);
}
