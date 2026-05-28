import * as commandService from "../services/commandService.js";

/**
 * ホワイトリストコマンドを実行してコードの検証等を行うツール関数
 */
export function verifyCodeChanges(userId: string, args: { command: string }): string {
  try {
    const output = commandService.runSandboxCommand(args.command);
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
