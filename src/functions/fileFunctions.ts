import * as fileService from "../services/fileService.js";

/**
 * ファイルを読み込むツール関数
 */
export function readCodeFile(userId: string, args: { filePath: string }): string {
  try {
    const content = fileService.readSandboxFile(args.filePath);
    return JSON.stringify({
      success: true,
      filePath: args.filePath,
      content,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * ファイルに書き込む（上書き）ツール関数
 */
export function writeCodeFile(userId: string, args: { filePath: string; content: string }): string {
  try {
    fileService.writeSandboxFile(args.filePath, args.content);
    return JSON.stringify({
      success: true,
      message: `ファイル "${args.filePath}" を正常に保存しました。`,
      filePath: args.filePath,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * ファイル一覧を取得するツール関数
 */
export function listCodeFiles(userId: string, args: { dirPath?: string }): string {
  try {
    const files = fileService.listSandboxFiles(args.dirPath || ".");
    return JSON.stringify({
      success: true,
      dirPath: args.dirPath || ".",
      files,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * キーワード検索を実行するツール関数
 */
export function searchCodeFiles(userId: string, args: { query: string; dirPath?: string }): string {
  try {
    const matches = fileService.searchSandboxFiles(args.query, args.dirPath || ".");
    return JSON.stringify({
      success: true,
      query: args.query,
      matches,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * ホワイトリストコマンドを実行してコードのコンパイルや動作検証を行うツール関数
 */
export function verifyCodeChanges(userId: string, args: { command: string }): string {
  try {
    const output = fileService.runSandboxCommand(args.command);
    return JSON.stringify({
      success: true,
      command: args.command,
      output,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}
