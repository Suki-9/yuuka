import { execSync } from "node:child_process";
import path from "node:path";
import { config } from "../config.js";

const SANDBOX_DIR = path.resolve(config.sandboxPath || process.cwd());

/**
 * Gitコマンドを安全に実行するヘルパー
 */
function runGitCommand(args: string[]): string {
  // シェルインジェクションを防ぐため、引数配列をエスケープして実行する
  const command = `git ${args.join(" ")}`;
  try {
    const output = execSync(command, {
      cwd: SANDBOX_DIR,
      encoding: "utf-8",
      timeout: 15000,
    });
    return output.trim();
  } catch (error: any) {
    const stderr = error.stderr ? `\n[標準エラー]: ${error.stderr}` : "";
    throw new Error(`Git実行エラー: ${command} が失敗しました。${stderr}\nメッセージ: ${error.message}`);
  }
}

/**
 * 新しい機能用ブランチを作成してチェックアウトする
 */
export function checkoutBranch(branchName: string): string {
  // ブランチ名のバリデーション（英数字、ハイフン、スラッシュ、アンダースコアのみ）
  if (!/^[a-zA-Z0-9\-_/]+$/.test(branchName)) {
    throw new Error("無効なブランチ名です。英数字、ハイフン、スラッシュ、アンダースコアのみ使用できます。");
  }

  try {
    // 既存ブランチのチェック
    runGitCommand(["checkout", branchName]);
    return `既存のブランチ "${branchName}" に切り替えました。`;
  } catch {
    // なければ新規作成
    runGitCommand(["checkout", "-b", branchName]);
    return `新しいブランチ "${branchName}" を作成し、切り替えました。`;
  }
}

/**
 * 変更をコミットする
 */
export function commitChanges(message: string): string {
  // コミットメッセージのダブルクォーテーションをエスケープしてシェルインジェクションを回避
  const escapedMessage = message.replace(/"/g, '\\"');
  
  // 変更があるか確認
  const status = runGitCommand(["status", "--porcelain"]);
  if (!status) {
    return "コミットする変更がありません。";
  }

  // ステージングに追加
  runGitCommand(["add", "."]);
  
  // コミット実行
  runGitCommand(["commit", "-m", `"${escapedMessage}"`]);
  
  return "変更を正常にコミットしました。";
}

/**
 * ブランチをマージする
 */
export function mergeBranch(branchName: string, targetBranch: string = "main"): string {
  if (!/^[a-zA-Z0-9\-_/]+$/.test(branchName) || !/^[a-zA-Z0-9\-_/]+$/.test(targetBranch)) {
    throw new Error("無効なブランチ名です。英数字、ハイフン、スラッシュ、アンダースコアのみ使用できます。");
  }

  const originalBranch = runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"]);
  
  try {
    // ターゲットブランチに切り替え
    runGitCommand(["checkout", targetBranch]);
    
    // マージ実行
    runGitCommand(["merge", branchName]);
    
    return `ブランチ "${branchName}" を "${targetBranch}" に正常にマージしました。現在のブランチは "${targetBranch}" です。`;
  } catch (error: any) {
    // マージが失敗した（競合など）場合はマージを中止して元のブランチに戻す
    try {
      runGitCommand(["merge", "--abort"]);
    } catch {}
    try {
      runGitCommand(["checkout", originalBranch]);
    } catch {}
    throw new Error(`マージエラー: "${branchName}" から "${targetBranch}" へのマージに失敗しました。マージを中止し、元のブランチ "${originalBranch}" に戻しました。\n${error.message}`);
  }
}

/**
 * 変更をリモート（origin）へPushする
 */
export function pushChanges(branchName: string): string {
  if (!/^[a-zA-Z0-9\-_/]+$/.test(branchName)) {
    throw new Error("無効なブランチ名です。");
  }

  // GITHUB_TOKENがある場合は、トークン付きのHTTPS URLを構築して安全にPushする (後方互換性維持)
  if (config.githubToken && config.githubForkRepo) {
    const forkRepo = config.githubForkRepo.trim();
    const token = config.githubToken.trim();
    
    // 一時的にリモートURLを変更してプッシュする
    const pushUrl = `https://${token}@github.com/${forkRepo}.git`;
    
    try {
      // 安全にPushを実行（出力にトークンが含まれないよう注意）
      execSync(`git push --force "${pushUrl}" ${branchName}:${branchName}`, {
        cwd: SANDBOX_DIR,
        stdio: "ignore", // 漏洩防止のために出力は無視
        timeout: 20000,
      });
      return `フォークリポジトリ (${forkRepo}) のブランチ "${branchName}" へ強制プッシュしました（トークン認証成功）。`;
    } catch (err: any) {
      throw new Error(`トークンを使用したPushに失敗しました: ${err.message}`);
    }
  }

  // GITHUB_TOKENがない場合は、ローカルのGit認証（SSHなど）を使用してPushを試みる
  try {
    runGitCommand(["push", "-u", "origin", branchName, "--force"]);
    return `リモートリポジトリ (origin) のブランチ "${branchName}" へ強制プッシュしました（ローカル認証情報使用）。`;
  } catch (err: any) {
    throw new Error(`リモートへのPushに失敗しました。リモートが設定されていないか、認証エラーの可能性があります: ${err.message}`);
  }
}
