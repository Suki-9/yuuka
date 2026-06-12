import { google, drive_v3 } from "googleapis";
import { getOAuthClientForUser } from "./googleCalendarService.js";
import fs from "node:fs";

// ─── Google Drive 連携（§8: バックアップはユーザー個人のDriveへ） ─────────────
// v2: OAuth情報はユーザー単位（users テーブル）。スコープは drive.file。

/**
 * ユーザー別の Google Drive API クライアントを取得
 */
function getDriveClient(userId: string): drive_v3.Drive | null {
  const auth = getOAuthClientForUser(userId);
  if (!auth) return null;
  try {
    return google.drive({ version: "v3", auth });
  } catch (error) {
    console.error("Google Drive 認証クライアントの初期化に失敗しました:", error);
    return null;
  }
}

/** Drive連携が有効か */
export function isDriveEnabled(userId: string): boolean {
  return getDriveClient(userId) !== null;
}

/**
 * Google Driveにファイルをアップロードする。
 * 世代管理（§8.2）のため同名上書きはせず、常に新規ファイルとして作成する。
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
    throw new Error("Google Driveクライアントが初期化されていません。Google OAuth連携を確認してください。");
  }

  try {
    const fileMetadata: drive_v3.Schema$File = { name: fileName };
    if (folderId) {
      fileMetadata.parents = [folderId];
    }
    const createRes = await drive.files.create({
      requestBody: fileMetadata,
      media: {
        mimeType,
        body: fs.createReadStream(filePath),
      },
      fields: "id, webViewLink",
    });
    const fileId = createRes.data.id!;
    const webViewLink = createRes.data.webViewLink || "";
    console.log(`Google Driveに新規ファイル(ID: ${fileId})を作成しました: ${fileName}`);
    return { fileId, url: webViewLink };
  } catch (error) {
    console.error("Google Driveへのアップロード中にエラーが発生しました:", error);
    throw error;
  }
}

/**
 * 名前プレフィックスでバックアップファイル一覧を取得する（作成日時の新しい順）
 */
export async function listBackupFiles(
  userId: string,
  namePrefix: string,
  folderId?: string
): Promise<{ id: string; name: string; createdTime: string }[]> {
  const drive = getDriveClient(userId);
  if (!drive) return [];

  try {
    // Drive APIの name contains は前方一致的に扱われないため、取得後にプレフィックスで絞る
    let query = `name contains '${namePrefix.replace(/'/g, "\\'")}' and trashed=false`;
    if (folderId) {
      query += ` and '${folderId}' in parents`;
    }
    const response = await drive.files.list({
      q: query,
      fields: "files(id, name, createdTime)",
      orderBy: "createdTime desc",
      pageSize: 100,
      spaces: "drive",
    });
    return (response.data.files || [])
      .filter((f) => f.id && f.name && f.name.startsWith(namePrefix))
      .map((f) => ({
        id: f.id!,
        name: f.name!,
        createdTime: f.createdTime || "",
      }));
  } catch (error) {
    console.error("Google Driveのバックアップ一覧取得に失敗しました:", error);
    return [];
  }
}

/**
 * Google Drive上のファイルを削除する（世代管理の古い世代削除用）
 */
export async function deleteDriveFile(userId: string, fileId: string): Promise<boolean> {
  const drive = getDriveClient(userId);
  if (!drive) return false;
  try {
    await drive.files.delete({ fileId });
    return true;
  } catch (error) {
    console.error(`Google Driveのファイル削除に失敗しました (ID: ${fileId}):`, error);
    return false;
  }
}
