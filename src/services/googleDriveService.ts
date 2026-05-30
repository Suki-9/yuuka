import { google, drive_v3 } from "googleapis";
import { getUserGoogleConfig } from "../db/userRepo.js";
import { config } from "../config.js";
import fs from "node:fs";

/**
 * ユーザー別の Google Drive API クライアントを取得
 */
function getDriveClient(userId: string): drive_v3.Drive | null {
  const googleConfig = getUserGoogleConfig(userId);
  if (!googleConfig) return null;

  const clientId = googleConfig.clientId || config.googleClientId;
  const clientSecret = googleConfig.clientSecret || config.googleClientSecret;

  if (!clientId || !clientSecret || !googleConfig.refreshToken) {
    return null;
  }

  try {
    // OAuth2 方式で認証クライアントを初期化
    const auth = new google.auth.OAuth2(
      clientId,
      clientSecret
    );
    auth.setCredentials({
      refresh_token: googleConfig.refreshToken,
    });
    return google.drive({ version: "v3", auth });
  } catch (error) {
    console.error("Google Drive 認証クライアントの初期化に失敗しました:", error);
  }

  return null;
}

/**
 * Google Driveにファイルをアップロード（同名ファイルがあれば上書き）
 */
export async function uploadToGoogleDrive(
  userId: string,
  filePath: string,
  fileName: string,
  mimeType: string = "application/zip",
  folderId?: string
): Promise<{ fileId: string; url: string } | null> {
  const drive = getDriveClient(userId);
  if (!drive) {
    throw new Error("Google Driveクライアントが初期化されていません。Google OAuth設定を確認してください。");
  }

  try {
    // 同じ名前のファイルが既に存在するか検索する
    let query = `name='${fileName}' and trashed=false`;
    if (folderId) {
      query += ` and '${folderId}' in parents`;
    }

    const response = await drive.files.list({
      q: query,
      fields: "files(id, name, webViewLink)",
      spaces: "drive",
    });

    const existingFiles = response.data.files || [];
    let fileId: string | null = null;
    let webViewLink: string | null = null;

    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath),
    };

    if (existingFiles.length > 0) {
      // 既存のファイルを上書き
      fileId = existingFiles[0].id!;
      const updateRes = await drive.files.update({
        fileId: fileId,
        media: media,
        fields: "id, webViewLink",
      });
      webViewLink = updateRes.data.webViewLink || "";
      console.log(`Google Drive上のファイル(ID: ${fileId})を上書き更新しました。`);
    } else {
      // 新規作成
      const fileMetadata: drive_v3.Schema$File = {
        name: fileName,
      };
      if (folderId) {
        fileMetadata.parents = [folderId];
      }
      const createRes = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: "id, webViewLink",
      });
      fileId = createRes.data.id!;
      webViewLink = createRes.data.webViewLink || "";
      console.log(`Google Driveに新規ファイル(ID: ${fileId})を作成しました。`);
    }

    return { fileId, url: webViewLink };
  } catch (error) {
    console.error("Google Driveへのアップロード中にエラーが発生しました:", error);
    throw error;
  }
}
