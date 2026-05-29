import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";

// サンドボックスディレクトリの解決 (config.sandboxPath があればそれを使用、なければ process.cwd())
const SANDBOX_DIR = path.resolve(config.sandboxPath || process.cwd());

/**
 * 許可されたホワイトリストコマンドのみをシェルで実行する
 */
export function runSandboxCommand(command: string): string {
  const allowedCommands = [
    /^npm\s+run\s+build$/,
    /^npm\s+run\s+compile$/,
    /^npx\s+tsc$/,
    /^npm\s+test$/,
    /^git\s+status$/,
    /^git\s+diff$/,
    /^git\s+diff\s+--cached$/,
    /^git\s+log\s+-n\s+\d+$/,
    /^curl\s+[-a-zA-Z0-9_.\s/:%?=+@~]+$/, // 安全なcurlコマンド
  ];

  const cleanCommand = command.trim();
  const isAllowed = allowedCommands.some(regex => regex.test(cleanCommand));

  if (!isAllowed) {
    throw new Error(`実行拒否: 安全のため、コマンド "${command}" は実行が許可されていません。\n許可されているコマンド: npm run build, npx tsc, npm test, git status, git diff, git log, curl`);
  }

  try {
    const output = execSync(cleanCommand, {
      cwd: SANDBOX_DIR,
      encoding: "utf-8",
      timeout: 30000,
      env: { ...process.env, LANG: "ja_JP.UTF-8" }
    });
    return output || "（コマンドは何も出力せずに正常終了しました）";
  } catch (error: any) {
    const stdout = error.stdout ? `\n[標準出力]:\n${error.stdout}` : "";
    const stderr = error.stderr ? `\n[標準エラー]:\n${error.stderr}` : "";
    return `⚠️ コマンド実行がエラーで終了しました (終了コード: ${error.status || "不明"})${stdout}${stderr}\nエラーメッセージ: ${error.message}`;
  }
}
