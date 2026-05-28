import fs from "node:fs";
import path from "node:path";

// サンドボックスディレクトリをプロジェクトルートに固定
const SANDBOX_DIR = path.resolve(process.cwd());

/**
 * 対象パスを解決し、サンドボックスディレクトリ内にあるか検証する
 * @returns 解決済みの絶対パス
 */
export function validatePath(targetPath: string): string {
  const resolved = path.resolve(SANDBOX_DIR, targetPath);
  if (!resolved.startsWith(SANDBOX_DIR)) {
    throw new Error(`アクセス権限エラー: 指定されたパスはサンドボックスの外部を指しています。(${targetPath})`);
  }
  return resolved;
}

/**
 * ファイルの中身を読み込む
 */
export function readSandboxFile(filePath: string): string {
  const resolvedPath = validatePath(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`ファイルが見つかりません: ${filePath}`);
  }
  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error(`指定されたパスはファイルではありません: ${filePath}`);
  }
  return fs.readFileSync(resolvedPath, "utf-8");
}

/**
 * ファイルに書き込む（ディレクトリがなければ自動作成する）
 */
export function writeSandboxFile(filePath: string, content: string): void {
  const resolvedPath = validatePath(filePath);
  
  // 禁止拡張子の簡易防御
  if (resolvedPath.endsWith(".db") || resolvedPath.endsWith(".sqlite")) {
    throw new Error("データベースファイルを直接上書きすることは禁止されています。");
  }

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(resolvedPath, content, "utf-8");
}

/**
 * サンドボックス内のファイルを再帰的に一覧表示する（不要なディレクトリは無視）
 */
export function listSandboxFiles(dirPath: string = "."): string[] {
  const resolvedDir = validatePath(dirPath);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    throw new Error(`ディレクトリが見つかりません: ${dirPath}`);
  }

  const result: string[] = [];
  const ignoreDirs = [".git", "node_modules", "dist", "data"];

  function traverse(currentDir: string) {
    const files = fs.readdirSync(currentDir);
    for (const file of files) {
      const fullPath = path.join(currentDir, file);
      const relativePath = path.relative(SANDBOX_DIR, fullPath);

      // 無視対象ディレクトリをスキップ
      if (ignoreDirs.some(ignore => relativePath.startsWith(ignore) || file === ignore)) {
        continue;
      }

      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        traverse(fullPath);
      } else {
        result.push(relativePath);
      }
    }
  }

  traverse(resolvedDir);
  return result;
}

/**
 * サンドボックス内のファイルをキーワードで検索する（簡易grep）
 */
export function searchSandboxFiles(query: string, dirPath: string = "."): { file: string; line: number; content: string }[] {
  const files = listSandboxFiles(dirPath);
  const results: { file: string; line: number; content: string }[] = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    const resolvedPath = validatePath(file);
    
    // バイナリファイルや大きなファイルはスキップ（簡易的な拡張子チェック）
    if (file.endsWith(".png") || file.endsWith(".jpg") || file.endsWith(".lock") || file.endsWith(".db")) {
      continue;
    }

    try {
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          results.push({
            file,
            line: i + 1,
            content: lines[i].trim(),
          });
          // 結果数が多すぎる場合は打ち切る (最大50件)
          if (results.length >= 50) {
            return results;
          }
        }
      }
    } catch (err) {
      // 読み込み失敗時はログに出力してスキップ
      console.warn(`ファイル検索スキップ: ${file}`, err);
    }
  }

  return results;
}

