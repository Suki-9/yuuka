import { runMigrations } from "../src/db/migrations.js";
import { createUser, listAllUsers } from "../src/db/userRepo.js";
import { getBotById, listBotsForUser } from "../src/db/botRepo.js";
import { getDb } from "../src/db/database.js";
import { encryptText } from "../src/utils/crypto.js";
import fs from "fs";

async function runTest() {
  console.log("1. Running database migrations...");
  await runMigrations();

  const db = getDb();
  
  const initialUsers = listAllUsers();
  const initialBots = db.prepare("SELECT COUNT(*) as c FROM bots").get() as { c: number };
  console.log(`Initial state: users=${initialUsers.length}, bots=${initialBots.c}`);

  if (initialUsers.length !== 0 || initialBots.c !== 0) {
    throw new Error("Initial state should be empty!");
  }

  console.log("2. Registering first user (Admin)...");
  const adminUser = createUser("123456", "admin_user", "password123");
  console.log(`Registered user: id=${adminUser.discord_id}, role=${adminUser.role}`);

  const postRegisterUsers = listAllUsers();
  const postRegisterBots = db.prepare("SELECT COUNT(*) as c FROM bots").get() as { c: number };
  console.log(`Post-register state: users=${postRegisterUsers.length}, bots=${postRegisterBots.c}`);

  if (postRegisterUsers.length !== 1 || postRegisterBots.c !== 0) {
    throw new Error("Post-register state should have 1 user and 0 bots!");
  }
  if (postRegisterUsers[0].role !== "admin") {
    throw new Error("First user should be an admin!");
  }

  console.log("3. Setting up default bot token...");
  const enc = encryptText("dummy-discord-bot-token");
  db.prepare(`
    INSERT OR REPLACE INTO bots (
      id, user_id, name, discord_token_encrypted, discord_token_iv, discord_token_tag, suspended
    ) VALUES ('system_default', ?, 'システムデフォルト', ?, ?, ?, 0)
  `).run(adminUser.discord_id, enc.encrypted, enc.iv, enc.authTag);

  db.prepare(`
    INSERT OR IGNORE INTO user_bot_access (user_id, bot_id)
    VALUES (?, 'system_default')
  `).run(adminUser.discord_id);

  const postSetupUsers = listAllUsers();
  const postSetupBots = db.prepare("SELECT COUNT(*) as c FROM bots").get() as { c: number };
  console.log(`Post-setup state: users=${postSetupUsers.length}, bots=${postSetupBots.c}`);

  if (postSetupUsers.length !== 1 || postSetupBots.c !== 1) {
    throw new Error("Post-setup state should have 1 user and 1 bot!");
  }

  const botsForAdmin = listBotsForUser(adminUser.discord_id);
  console.log(`Bots accessible to admin: ${JSON.stringify(botsForAdmin.map(b => b.id))}`);
  if (!botsForAdmin.some(b => b.id === "system_default")) {
    throw new Error("Admin should be able to access system_default!");
  }

  console.log("4. Registering a second user (Normal)...");
  const normalUser = createUser("789012", "normal_user", "password456");
  console.log(`Registered second user: id=${normalUser.discord_id}, role=${normalUser.role}`);

  const postSecondUsers = listAllUsers();
  const postSecondBots = db.prepare("SELECT COUNT(*) as c FROM bots").get() as { c: number };
  console.log(`Post-second-user state: users=${postSecondUsers.length}, bots=${postSecondBots.c}`);

  // Second user has no default bot created automatically, but has access to system_default via listBotsForUser
  const botsForSecondUser = listBotsForUser(normalUser.discord_id);
  console.log(`Bots accessible to normal user: ${JSON.stringify(botsForSecondUser.map(b => b.id))}`);
  if (!botsForSecondUser.some(b => b.id === "system_default")) {
    throw new Error("Normal user should be able to access system_default!");
  }

  console.log("✅ All database transitions verified successfully!");
}

runTest().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
