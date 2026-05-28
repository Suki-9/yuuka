import * as gitService from "../services/gitService.js";

/**
 * ブランチを作成・切り替えするツール関数
 */
export function checkoutBranch(userId: string, args: { branchName: string }): string {
  try {
    const result = gitService.checkoutBranch(args.branchName);
    return JSON.stringify({
      success: true,
      message: result,
      branchName: args.branchName,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * 変更をローカルにコミットするツール関数
 */
export function commitLocalChanges(
  userId: string,
  args: { commitMessage: string }
): string {
  try {
    const result = gitService.commitChanges(args.commitMessage);
    if (result === "コミットする変更がありません。") {
      return JSON.stringify({
        success: false,
        message: "コミットする変更（差分）が存在しません。ファイルを修正したか確認してください。",
      });
    }

    return JSON.stringify({
      success: true,
      message: result,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * ブランチをマージするツール関数
 */
export function mergeBranch(
  userId: string,
  args: { branchName: string; targetBranch?: string }
): string {
  try {
    const result = gitService.mergeBranch(args.branchName, args.targetBranch || "main");
    return JSON.stringify({
      success: true,
      message: result,
      branchName: args.branchName,
      targetBranch: args.targetBranch || "main",
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * 変更をリモートへPushするツール関数
 */
export function pushChanges(
  userId: string,
  args: { branchName: string }
): string {
  try {
    const result = gitService.pushChanges(args.branchName);
    return JSON.stringify({
      success: true,
      message: result,
      branchName: args.branchName,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}
