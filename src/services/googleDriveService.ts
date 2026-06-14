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
 * バックアップ先フォルダ指定値を正規化し、フォルダIDを取り出す。
 * フォルダID単体・各種Google DriveフォルダURLのどちらでも受け付ける。
 * 例:
 *   - https://drive.google.com/drive/folders/<ID>
 *   - https://drive.google.com/drive/u/0/folders/<ID>?usp=sharing
 *   - https://drive.google.com/open?id=<ID>
 *   - <ID>
 * 抽出できない場合は null を返す（呼び出し側で未設定として扱う）。
 */
export function extractDriveFolderId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  // URLでない場合はフォルダID本体とみなす（DriveのIDは英数字・ハイフン・アンダースコア）
  if (!/^https?:\/\//i.test(value)) {
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
  }

  try {
    const url = new URL(value);
    // 形式1: /drive/folders/<ID> や /drive/u/0/folders/<ID>
    const folderMatch = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/);
    if (folderMatch) return folderMatch[1];
    // 形式2: ?id=<ID>（open?id=... 等）
    const idParam = url.searchParams.get("id");
    if (idParam && /^[A-Za-z0-9_-]+$/.test(idParam)) return idParam;
    return null;
  } catch {
    return null;
  }
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
