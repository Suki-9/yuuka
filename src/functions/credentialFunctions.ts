import * as secretService from "../services/secretService.js";

/**
 * AIエージェントが安全に資格情報を取得するためのツール関数
 */
export async function getCredential(
  userId: string,
  args: { service_name: string }
): Promise<string> {
  try {
    const serviceName = args.service_name;
    if (!serviceName) {
      return JSON.stringify({
        success: false,
        message: "サービス名が指定されていません。",
      });
    }

    console.log(`🔒 AIエージェントが資格情報のロードを要求: ${serviceName}`);
    const credential = secretService.getDecryptedCredential(serviceName);

    if (!credential) {
      return JSON.stringify({
        success: false,
        message: `指定されたサービス [${serviceName}] の資格情報が見つかりません。管理室の「AI認証情報管理」から先に登録してください。`,
      });
    }

    return JSON.stringify({
      success: true,
      serviceName,
      username: credential.username,
      password: credential.password,
    });
  } catch (err: any) {
    console.error(`[AI Tool] getCredential 実行エラー:`, err.message);
    return JSON.stringify({
      success: false,
      message: `資格情報の取得中にエラーが発生しました: ${err.message}`,
    });
  }
}

/**
 * AIエージェントが登録されている資格情報のインデックス（サービス名とユーザー名）の一覧を取得するためのツール関数
 */
export async function listCredentials(
  userId: string,
  args: {}
): Promise<string> {
  try {
    console.log(`🔒 AIエージェントが資格情報インデックス一覧の取得を要求`);
    const list = secretService.listCredentials();
    return JSON.stringify({
      success: true,
      credentials: list,
    });
  } catch (err: any) {
    console.error(`[AI Tool] listCredentials 実行エラー:`, err.message);
    return JSON.stringify({
      success: false,
      message: `資格情報一覧の取得中にエラーが発生しました: ${err.message}`,
    });
  }
}

