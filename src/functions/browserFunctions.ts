import * as browserService from "../services/browserService.js";

/**
 * 動的なウェブページのテキスト内容を取得するツール関数
 */
export async function fetchDynamicPage(userId: string, args: { url: string }): Promise<string> {
  try {
    const { title, markdown } = await browserService.fetchCleanPageContent(args.url);
    return JSON.stringify({
      success: true,
      url: args.url,
      title: title,
      markdownContent: markdown.slice(0, 30000), // より詳細な内容を読み込めるように30,000文字に拡張
      htmlContent: markdown.slice(0, 30000),     // 既存プロンプトとの互換性のために同一のテキストを設定
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * ウェブページのスクリーンショットを撮影するツール関数
 */
export async function takePageScreenshot(userId: string, args: { url: string }): Promise<string> {
  try {
    const relativePath = await browserService.takePageScreenshot(args.url);
    return JSON.stringify({
      success: true,
      url: args.url,
      message: `スクリーンショットの撮影に成功しました。`,
      imagePath: relativePath,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}

/**
 * インターネット上の最新情報を検索するツール関数
 */
export async function searchWeb(userId: string, args: { query: string }): Promise<string> {
  try {
    const results = await browserService.searchWeb(args.query);
    return JSON.stringify({
      success: true,
      query: args.query,
      results,
    });
  } catch (err: any) {
    return JSON.stringify({
      success: false,
      message: err.message,
    });
  }
}
