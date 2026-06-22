import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (!db) {
		// data ディレクトリが存在しなければ作成
		const dir = path.dirname(config.dbPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		db = new Database(config.dbPath);
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
	}
	return db;
}

export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}
