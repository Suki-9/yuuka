import { getDb } from "../src/db/database.js";
import { updateUsername } from "../src/db/userRepo.js";
import { runMigrations } from "../src/db/migrations.js";

async function main() {
  // Use a temporary test database
  process.env.DB_PATH = "./data/yuuka_test.db";
  console.log("DB PATH:", process.env.DB_PATH);
  
  await runMigrations();
  
  const db = getDb();
  // Clear test users if any
  db.prepare("DELETE FROM users WHERE discord_id IN ('test_user_id_1', 'test_user_id_3')").run();

  // Create test users
  try {
    db.prepare(`
      INSERT INTO users (discord_id, username, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run("test_user_id_1", "TestUser1", "hash", "user");
  } catch (e) {
    console.log("User already exists or error inserting:", e);
  }

  // 1. Same name
  console.log("--- Test 1: Update to same username ---");
  try {
    const res1 = updateUsername("test_user_id_1", "TestUser1");
    console.log("Result 1 (same name):", res1);
  } catch (e) {
    console.error("Error 1:", e);
  }

  // 2. New name
  console.log("--- Test 2: Update to new username ---");
  try {
    const res2 = updateUsername("test_user_id_1", "TestUser2");
    console.log("Result 2 (new name):", res2);
  } catch (e) {
    console.error("Error 2:", e);
  }

  // 3. Duplicate name
  try {
    db.prepare(`
      INSERT INTO users (discord_id, username, password_hash, role)
      VALUES (?, ?, ?, ?)
    `).run("test_user_id_3", "TestUser3", "hash", "user");
  } catch (e) {}

  console.log("--- Test 3: Update to duplicate username ---");
  try {
    const res3 = updateUsername("test_user_id_1", "TestUser3");
    console.log("Result 3 (duplicate):", res3);
  } catch (e) {
    console.error("Error 3 (expected unique constraint error):", e);
  }
}

main().catch(console.error);
