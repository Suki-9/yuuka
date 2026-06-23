import * as browserService from "../services/browserService.js";

/**
 * 動的なウェブページのテキスト内容を取得するツール関数
 */
export async function fetchDynamicPage(
	_userId: string,
	args: { url: string },
): Promise<string> {
	try {
		const { title, markdown } = await browserService.fetchCleanPageContent(
			args.url,
		);
		return JSON.stringify({
			success: true,
			url: args.url,
			title: title,
			markdownContent: markdown.slice(0, 30000), // より詳細な内容を読み込めるように30,000文字に拡張
			htmlContent: markdown.slice(0, 30000), // 既存プロンプトとの互換性のために同一のテキストを設定
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
export async function takePageScreenshot(
	_userId: string,
	args: { url: string },
): Promise<string> {
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
export async function searchWeb(
	_userId: string,
	args: { query: string },
): Promise<string> {
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

/**
 * 永続インタラクティブブラウザで指定されたURLを開く
 */
export async function browserInteractiveOpen(
	userId: string,
	args: { url: string },
): Promise<string> {
	try {
		const res = await browserService.browserInteractiveOpen(userId, args.url);
		return JSON.stringify(res);
	} catch (err: any) {
		return JSON.stringify({ success: false, message: err.message });
	}
}

/**
 * 永続インタラクティブブラウザの要素（または文言）をクリックする
 */
export async function browserInteractiveClick(
	userId: string,
	args: { selector: string },
): Promise<string> {
	try {
		const res = await browserService.browserInteractiveClick(
			userId,
			args.selector,
		);
		return JSON.stringify(res);
	} catch (err: any) {
		return JSON.stringify({ success: false, message: err.message });
	}
}

/**
 * 永続インタラクティブブラウザの入力フィールドにテキストを入力する
 */
export async function browserInteractiveType(
	userId: string,
	args: { selector: string; text: string },
): Promise<string> {
	try {
		const res = await browserService.browserInteractiveType(
			userId,
			args.selector,
			args.text,
		);
		return JSON.stringify(res);
	} catch (err: any) {
		return JSON.stringify({ success: false, message: err.message });
	}
}

/**
 * 永続インタラクティブブラウザで待機する
 */
export async function browserInteractiveWait(
	userId: string,
	args: { selector?: string; timeoutMs?: number },
): Promise<string> {
	try {
		const res = await browserService.browserInteractiveWait(
			userId,
			args.selector,
			args.timeoutMs,
		);
		return JSON.stringify(res);
	} catch (err: any) {
		return JSON.stringify({ success: false, message: err.message });
	}
}

/**
 * 永続インタラクティブブラウザのアクティブ状態を取得する
 */
export async function browserInteractiveStatus(
	userId: string,
): Promise<string> {
	try {
		const res = await browserService.browserInteractiveStatus(userId);
		return JSON.stringify(res);
	} catch (err: any) {
		return JSON.stringify({ success: false, message: err.message });
	}
}

/**
 * 永続インタラクティブブラウザセッションをクローズする
 */
export async function browserInteractiveClose(userId: string): Promise<string> {
	try {
		const res = await browserService.browserInteractiveClose(userId);
		return JSON.stringify(res);
	} catch (err: any) {
		return JSON.stringify({ success: false, message: err.message });
	}
}
