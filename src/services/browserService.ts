import puppeteer, { Browser, Page } from "puppeteer";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCREENSHOT_DIR = path.resolve(process.cwd(), "data/screenshots");
const DEBUG_SCRAPES_DIR = path.resolve(process.cwd(), "data/debug_scrapes");

// 保存用ディレクトリの確保
[SCREENSHOT_DIR, DEBUG_SCRAPES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 1時間以上経過した不要な画像やMDファイルを削除する
function cleanupOldFiles() {
  const ONE_HOUR = 60 * 60 * 1000;
  const now = Date.now();
  
  [SCREENSHOT_DIR, DEBUG_SCRAPES_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) return;
    fs.readdir(dir, (err, files) => {
      if (err) return;
      files.forEach((file) => {
        const filePath = path.join(dir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;
          if (now - stats.mtimeMs > ONE_HOUR) {
            fs.unlink(filePath, () => {});
          }
        });
      });
    });
  });
}

// 起動時とその後1時間ごとにクリーンアップを実行
cleanupOldFiles();
setInterval(cleanupOldFiles, 60 * 60 * 1000);

// バイナリパス候補
const CRAWLER_BIN_PATHS = [
  path.resolve(process.cwd(), "src/rust_crawler/target/release/yuuka-crawler"),
  path.resolve(process.cwd(), "src/rust_crawler/target/debug/yuuka-crawler"),
  path.resolve(process.cwd(), "dist/bin/yuuka-crawler"),
];

function getCrawlerBinPath(): string | null {
  for (const binPath of CRAWLER_BIN_PATHS) {
    if (fs.existsSync(binPath)) {
      return binPath;
    }
  }
  return null;
}

async function runRustCrawler(command: "fetch" | "search", target: string): Promise<string> {
  const binPath = getCrawlerBinPath();
  if (!binPath) {
    throw new Error("Rust crawler binary not found.");
  }
  const { stdout } = await execFileAsync(binPath, [command, target], {
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 30000, // 30秒
  });
  return stdout;
}

// ─── 永続インタラクティブブラウザ状態（ユーザー別分離） ───────────────────────────────────
interface BrowserSession {
  browser: Browser;
  page: Page;
  lastInteractionTime: number;
  autoCloseTimer: NodeJS.Timeout | null;
}
const userSessions = new Map<string, BrowserSession>();
const AUTO_CLOSE_TIMEOUT_MS = 5 * 60 * 1000; // 5分間無操作で自動クローズ

function scheduleAutoClose(userId: string) {
  const session = userSessions.get(userId);
  if (!session) return;
  if (session.autoCloseTimer) {
    clearTimeout(session.autoCloseTimer);
  }
  session.autoCloseTimer = setTimeout(async () => {
    const s = userSessions.get(userId);
    if (s && Date.now() - s.lastInteractionTime >= AUTO_CLOSE_TIMEOUT_MS) {
      console.log(`[Interactive Browser] [User: ${userId}] 自動クローズタイマー作動 (5分間無操作)`);
      await closeInteractiveBrowser(userId).catch(() => {});
    }
  }, AUTO_CLOSE_TIMEOUT_MS);
}

async function getInteractiveBrowser(userId: string): Promise<{ browser: Browser; page: Page }> {
  const existing = userSessions.get(userId);

  if (existing) {
    existing.lastInteractionTime = Date.now();
    scheduleAutoClose(userId);
    try {
      // 接続確認のためのダミー実行
      await existing.page.evaluate(() => 1);
      return { browser: existing.browser, page: existing.page };
    } catch {
      await closeInteractiveBrowser(userId).catch(() => {});
    }
  }

  const USER_DATA_DIR = path.resolve(process.cwd(), `data/browser_profiles/${userId}`);

  console.log(`[Interactive Browser] [User: ${userId}] 新しいブラウザセッションを起動します...`);
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    userDataDir: USER_DATA_DIR,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  });

  const session: BrowserSession = {
    browser,
    page,
    lastInteractionTime: Date.now(),
    autoCloseTimer: null,
  };
  userSessions.set(userId, session);
  scheduleAutoClose(userId);

  return { browser, page };
}

export async function closeInteractiveBrowser(userId: string): Promise<void> {
  const session = userSessions.get(userId);
  if (!session) return;
  if (session.autoCloseTimer) {
    clearTimeout(session.autoCloseTimer);
  }
  try {
    await session.browser.close();
  } catch {}
  userSessions.delete(userId);
  console.log(`[Interactive Browser] [User: ${userId}] ブラウザセッションをクローズしました。`);
}

/**
 * ページからクリーンなMarkdownコンテンツを非破壊的（要素を削除しない）に抽出するヘルパー
 */
async function extractPageMarkdown(page: Page, isInteractive: boolean): Promise<string> {
  try {
    await page.evaluate(() => {
      (window as any).__name = (fn: any) => fn;
    });
  } catch {}

  const rawMarkdown = await page.evaluate((interactive: boolean) => {
    function isVisible(el: any) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    const noiseKeywords = ["footer", "nav", "sidebar", "menu", "ads"];
    function isNoiseElement(el: any): boolean {
      const id = el.id ? el.id.toLowerCase() : "";
      const className = el.className && typeof el.className === "string" ? el.className.toLowerCase() : "";
      return noiseKeywords.some(keyword => id.includes(keyword) || className.includes(keyword));
    }

    function traverse(node: any, isPre = false): string {
      if (!node) return "";

      if (node.nodeType === Node.ELEMENT_NODE && !isVisible(node)) {
        return "";
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || "";
        if (isPre) return text;
        return text.replace(/\s+/g, " ");
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return "";
      }

      const tagName = node.tagName.toLowerCase();

      // 基本的な不要タグの除外
      const baseUnwanted = ["script", "style", "noscript", "iframe", "svg", "img", "link", "meta"];
      if (baseUnwanted.includes(tagName)) {
        return "";
      }

      // インタラクティブでない場合はフォームパーツなども除外
      if (!interactive) {
        const normalUnwanted = ["header", "footer", "nav", "aside", "select", "button", "input", "textarea"];
        if (normalUnwanted.includes(tagName) || isNoiseElement(node)) {
          return "";
        }
      }

      // 等幅・整形済みテキスト/コードブロック
      if (tagName === "pre" || tagName === "code") {
        if (tagName === "pre") {
          let codeText = "";
          for (const child of Array.from(node.childNodes)) {
            codeText += traverse(child, true);
          }
          return `\n\`\`\`\n${codeText.trim()}\n\`\`\`\n`;
        } else {
          let codeText = "";
          for (const child of Array.from(node.childNodes)) {
            codeText += traverse(child, true);
          }
          return ` \`${codeText.trim()}\` `;
        }
      }

      // インタラクティブ要素のカスタムレンダリング
      if (interactive) {
        const yuukaId = node.getAttribute("data-yuuka-id") || "";
        const idStr = yuukaId ? ` ID: ${yuukaId}` : "";

        if (tagName === "input") {
          const type = node.getAttribute("type") || "text";
          const name = node.getAttribute("name") || "";
          const id = node.id || "";
          const placeholder = node.getAttribute("placeholder") || "";
          const val = node.value || "";
          // パスワード値はセキュリティのためマスクする（値が入っている場合のみ）
          const displayVal = type === "password" ? (val ? "********" : "") : val;
          return ` [Input (${type})${idStr} id="${id}" name="${name}" placeholder="${placeholder}" value="${displayVal}"] `;
        }

        if (tagName === "textarea") {
          const name = node.getAttribute("name") || "";
          const id = node.id || "";
          const placeholder = node.getAttribute("placeholder") || "";
          const val = node.value || "";
          return ` [Textarea${idStr} id="${id}" name="${name}" placeholder="${placeholder}" value="${val}"] `;
        }

        if (tagName === "button") {
          let btnText = "";
          for (const child of Array.from(node.childNodes)) {
            btnText += traverse(child, isPre);
          }
          const id = node.id || "";
          const name = node.getAttribute("name") || "";
          return ` [Button${idStr}: "${btnText.trim()}" id="${id}" name="${name}"] `;
        }

        if (tagName === "select") {
          const name = node.getAttribute("name") || "";
          const id = node.id || "";
          const options = Array.from(node.querySelectorAll("option")).map((opt: any) => {
            return `${opt.value}:${opt.textContent?.trim() || ""}`;
          }).join(", ");
          return ` [Select${idStr} id="${id}" name="${name}" Options: {${options}}] `;
        }
      }

      let childrenText = "";
      for (const child of Array.from(node.childNodes)) {
        childrenText += traverse(child, isPre);
      }

      switch (tagName) {
        case "h1":
          return `\n\n# ${childrenText.trim()}\n\n`;
        case "h2":
          return `\n\n## ${childrenText.trim()}\n\n`;
        case "h3":
          return `\n\n### ${childrenText.trim()}\n\n`;
        case "h4":
        case "h5":
        case "h6":
          return `\n\n#### ${childrenText.trim()}\n\n`;
        case "p":
          return `\n\n${childrenText.trim()}\n\n`;
        case "br":
          return "\n";
        case "hr":
          return "\n\n---\n\n";
        case "a": {
          const href = node.href;
          const text = childrenText.trim();
          const yuukaId = interactive ? (node.getAttribute("data-yuuka-id") || "") : "";
          const idPrefix = yuukaId ? `[ID: ${yuukaId}] ` : "";
          if (href && text && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
            return ` ${idPrefix}[${text}](${href}) `;
          }
          if (yuukaId && text) {
            return ` ${idPrefix}${text} `;
          }
          return childrenText;
        }
        case "li":
          return `\n- ${childrenText.trim()}`;
        case "ul":
        case "ol":
          return `\n${childrenText}\n`;
        case "th":
        case "td": {
          const cellText = childrenText.replace(/[\r\n]+/g, " ").trim();
          const compressed = cellText.replace(/\s+/g, " ");
          return ` ${compressed} |`;
        }
        case "tr":
          return `\n|${childrenText}`;
        case "thead":
        case "tbody":
          return childrenText;
        case "table":
          return `\n\n${childrenText}\n\n`;
        default: {
          const isBlock = [
            "div", "section", "article", "aside", "main", "body", "blockquote", "form"
          ].includes(tagName);
          if (isBlock) {
            return `\n${childrenText}\n`;
          }
          return childrenText;
        }
      }
    }

    return traverse(document.body);
  }, isInteractive);

  const rawLines = rawMarkdown.split("\n");
  const cleanLines: string[] = [];
  let consecutiveEmpty = 0;
  let inCodeBlock = false;
  
  for (const line of rawLines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      consecutiveEmpty = 0;
      cleanLines.push(trimmedLine);
      continue;
    }
    
    if (inCodeBlock) {
      cleanLines.push(line);
      consecutiveEmpty = 0;
    } else {
      const trimmed = line.trim();
      if (trimmed === "") {
        consecutiveEmpty++;
        if (consecutiveEmpty <= 1) {
          cleanLines.push("");
        }
      } else {
        consecutiveEmpty = 0;
        cleanLines.push(trimmed);
      }
    }
  }
  
  return cleanLines.join("\n").trim();
}

/**
 * ヘッドレスブラウザでウェブページを開き、不要なタグを削除して可視部分をMarkdown形式にパースして取得する
 */
export async function fetchCleanPageContent(url: string): Promise<{ title: string; markdown: string }> {
  let result: { title: string; markdown: string } | null = null;

  // まず Rust クローラーによる高速フェッチを試みる
  try {
    console.log(`[Rust Crawler] Fetching: ${url}`);
    const markdown = await runRustCrawler("fetch", url);
    let title = "無題のページ";
    const titleMatch = markdown.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      title = titleMatch[1];
    }
    console.log(`[Rust Crawler] Successfully fetched and parsed: ${url}`);
    result = { title, markdown };
  } catch (err: any) {
    console.warn(`[Rust Crawler] Fetch failed: ${err.message}. Falling back to Puppeteer...`);
  }

  if (!result) {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    try {
      const page = await browser.newPage();
      
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      
      await page.setExtraHTTPHeaders({
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      });

      try {
        await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
      } catch (gotoError: any) {
        console.warn(`Navigation timeout or error for ${url}, extracting content anyway: ${gotoError.message}`);
      }

      const title = await page.title();
      const markdown = await extractPageMarkdown(page, false);

      result = {
        title: title || "無題のページ",
        markdown,
      };
    } finally {
      await browser.close();
    }
  }

  // 結果のMarkdownファイルをデバッグ用に保存する
  try {
    const lastFetchPath = path.join(DEBUG_SCRAPES_DIR, "debug_last_fetch.md");
    fs.writeFileSync(lastFetchPath, result.markdown, "utf-8");
    
    const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 100);
    const uniqueFilename = `fetch_${Date.now()}_${sanitizedUrl}.md`;
    const uniqueFetchPath = path.join(DEBUG_SCRAPES_DIR, uniqueFilename);
    fs.writeFileSync(uniqueFetchPath, result.markdown, "utf-8");
    
    console.log(`[Debug] Saved scraped markdown to: ${uniqueFetchPath}`);
  } catch (saveErr: any) {
    console.warn(`Failed to save debug scrape file: ${saveErr.message}`);
  }

  return result;
}

/**
 * ウェブページのスクリーンショットを撮影し、画像を保存する
 * @returns 保存された画像ファイルの相対パス
 */
export async function takePageScreenshot(url: string, filename: string = `screenshot_${Date.now()}.png`): Promise<string> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const safeFilename = path.basename(filename);
    const savePath = path.join(SCREENSHOT_DIR, safeFilename);
    await page.screenshot({ path: savePath, fullPage: true });

    return path.relative(process.cwd(), savePath);
  } finally {
    await browser.close();
  }
}

/**
 * Web検索を実行して検索結果を取得する
 */
export async function searchWeb(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    console.log(`[Rust Crawler] Searching: ${query}`);
    const jsonOutput = await runRustCrawler("search", query);
    const results = JSON.parse(jsonOutput);
    console.log(`[Rust Crawler] Successfully searched and found ${results.length} results.`);
    return results;
  } catch (err: any) {
    console.warn(`[Rust Crawler] Search failed: ${err.message}. Falling back to Puppeteer...`);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    });

    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    try {
      await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
      
      const googleResults = await page.evaluate(() => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];
        const elements = document.querySelectorAll("div.g");
        elements.forEach((el: any) => {
          const titleEl = el.querySelector("h3");
          const anchor = el.querySelector("a");
          const snippetEl = el.querySelector("div.VwiC3b, span.aCOpbc, div.yD3zGc");
          if (titleEl && anchor) {
            items.push({
              title: titleEl.textContent?.trim() || "",
              url: anchor.href || "",
              snippet: snippetEl?.textContent?.trim() || "",
            });
          }
        });
        return items;
      });

      if (googleResults && googleResults.length > 0) {
        return googleResults.slice(0, 8);
      }
    } catch (e: any) {
      console.warn(`Google Search failed or timed out: ${e.message}. Falling back to DuckDuckGo...`);
    }

    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    await page.goto(ddgUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    
    const ddgResults = await page.evaluate(() => {
      const items: Array<{ title: string; url: string; snippet: string }> = [];
      const elements = document.querySelectorAll(".result");
      elements.forEach((el: any) => {
        const titleEl = el.querySelector(".result__title a");
        const snippetEl = el.querySelector(".result__snippet");
        if (titleEl) {
          const anchor = titleEl as HTMLAnchorElement;
          items.push({
            title: anchor.textContent?.trim() || "",
            url: anchor.href || "",
            snippet: snippetEl?.textContent?.trim() || "",
          });
        }
      });
      return items;
    });

    return ddgResults.slice(0, 8);
  } finally {
    await browser.close();
  }
}

/**
 * ページ上のすべての可視な対話可能要素に、一時的な data-yuuka-id 属性を付与する
 */
export async function annotateInteractiveElements(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // 既存のIDを一旦クリア
      const oldElements = document.querySelectorAll("[data-yuuka-id]");
      oldElements.forEach((el) => el.removeAttribute("data-yuuka-id"));

      // 操作対象となるセレクタ
      const selectors = [
        "input:not([type='hidden'])",
        "button",
        "select",
        "textarea",
        "a",
        "[role='button']",
        "[onclick]",
      ].join(",");

      const elements = Array.from(document.querySelectorAll(selectors));
      let idCounter = 1;

      elements.forEach((el) => {
        // 画面上で見えているかチェック
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isVisible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";

        if (isVisible) {
          el.setAttribute("data-yuuka-id", String(idCounter++));
        }
      });
    });
  } catch (err: any) {
    console.warn(`[Interactive Browser] Annotation warning: ${err.message}`);
  }
}

// ─── 新規インタラクティブブラウザ関数群 ───────────────────────────────────────

/**
 * 永続ブラウザで指定URLを開く
 */
export async function browserInteractiveOpen(userId: string, url: string): Promise<{ success: boolean; title: string; url: string; message: string }> {
  const { page } = await getInteractiveBrowser(userId);
  try {
    console.log(`[Interactive Browser] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
  } catch (err: any) {
    console.warn(`[Interactive Browser] Navigation warn: ${err.message}, continuing...`);
  }
  const title = await page.title();
  const currentUrl = page.url();
  return {
    success: true,
    title: title || "無題のページ",
    url: currentUrl,
    message: `URL: ${url} を開きました。`,
  };
}

/**
 * 指定されたCSSセレクタまたはテキストに合致する要素をクリックする
 */
export async function browserInteractiveClick(userId: string, selector: string): Promise<{ success: boolean; message: string }> {
  const { page } = await getInteractiveBrowser(userId);

  // 数値IDまたは "id:数字" 形式のセレクタを [data-yuuka-id="数値"] に変換
  let actualSelector = selector;
  if (/^\d+$/.test(selector.trim())) {
    actualSelector = `[data-yuuka-id="${selector.trim()}"]`;
  } else if (/^id:(\d+)$/i.test(selector.trim())) {
    const m = selector.trim().match(/^id:(\d+)$/i);
    actualSelector = `[data-yuuka-id="${m![1]}"]`;
  }

  // jQuery style :contains or Playwright style :has-text parsing
  const containsRegex = /^([a-zA-Z0-9\-_]+)?(?::contains|:has-text)\(["']?(.+?)["']?\)$/;
  const match = actualSelector.match(containsRegex);
  if (match) {
    const targetTagName = match[1] || null;
    const cleanText = match[2];
    
    try {
      const clicked = await page.evaluate(({ tag, txt }: { tag: string | null; txt: string }) => {
        const query = tag ? tag : "a, button, input[type='button'], input[type='submit'], [role='button'], span, div, h1, h2, h3, h4";
        const elements = Array.from(document.querySelectorAll(query));
        const target = elements.find(el => {
          const elText = el.textContent?.trim() || "";
          const valText = el.getAttribute("value")?.trim() || "";
          return elText === txt || elText.includes(txt) || valText === txt || valText.includes(txt);
        });
        if (target) {
          (target as HTMLElement).click();
          return true;
        }
        return false;
      }, { tag: targetTagName, txt: cleanText });

      if (clicked) {
        await new Promise(r => setTimeout(r, 1000));
        return {
          success: true,
          message: `テキスト "${cleanText}" に合致する要素を見つけ出し、クリックしました。`,
        };
      }
    } catch (evalErr: any) {
      console.error("[Interactive Browser] Smart click contains evaluation error:", evalErr);
    }
    throw new Error(`テキスト "${cleanText}" に合致する要素 "${actualSelector}" のクリックに失敗しました。`);
  }

  try {
    // まず通常のCSSセレクタでの検出を試みる
    await page.waitForSelector(actualSelector, { visible: true, timeout: 5000 });
    await page.click(actualSelector);
    
    // クリック後の反応・遷移のために1秒待機
    await new Promise(r => setTimeout(r, 1000));
    return {
      success: true,
      message: `要素 "${actualSelector}" をクリックしました。`,
    };
  } catch (err: any) {
    // スマートフォールバック: セレクタをテキストマッチ（ボタンやリンクの文言）として評価する
    try {
      const clicked = await page.evaluate((txt: string) => {
        const elements = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [role='button'], span, div, h1, h2, h3, h4"));
        const target = elements.find(el => {
          const elText = el.textContent?.trim() || "";
          const valText = el.getAttribute("value")?.trim() || "";
          return elText === txt || elText.includes(txt) || valText === txt || valText.includes(txt);
        });
        if (target) {
          (target as HTMLElement).click();
          return true;
        }
        return false;
      }, actualSelector);

      if (clicked) {
        await new Promise(r => setTimeout(r, 1000));
        return {
          success: true,
          message: `テキスト "${actualSelector}" に合致する要素を見つけ出し、クリックしました。`,
        };
      }
    } catch (evalErr) {
      console.error("[Interactive Browser] Smart click fallback evaluation error:", evalErr);
    }
    throw new Error(`要素またはテキスト "${selector}" のクリックに失敗しました: ${err.message}`);
  }
}


/**
 * 指定されたCSSセレクタまたは属性部分一致の入力フィールドにテキストを入力する
 */
export async function browserInteractiveType(userId: string, selector: string, text: string): Promise<{ success: boolean; message: string }> {
  const { page } = await getInteractiveBrowser(userId);

  // 数値IDまたは "id:数字" 形式のセレクタを [data-yuuka-id="数値"] に変換
  let actualSelector = selector;
  if (/^\d+$/.test(selector.trim())) {
    actualSelector = `[data-yuuka-id="${selector.trim()}"]`;
  } else if (/^id:(\d+)$/i.test(selector.trim())) {
    const m = selector.trim().match(/^id:(\d+)$/i);
    actualSelector = `[data-yuuka-id="${m![1]}"]`;
  }

  try {
    await page.waitForSelector(actualSelector, { visible: true, timeout: 5000 });
    
    // 既存内容のクリア
    await page.focus(actualSelector);
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    
    await page.type(actualSelector, text, { delay: 50 });
    return {
      success: true,
      message: `要素 "${actualSelector}" にテキストを入力しました。`,
    };
  } catch (err: any) {
    // スマートフォールバック: プレースホルダー名、name属性、id、aria-labelの部分一致で入力要素を探す
    try {
      const typed = await page.evaluate(({ sel, txt }: { sel: string; txt: string }) => {
        const inputs = Array.from(document.querySelectorAll("input, textarea"));
        const target = inputs.find(el => {
          const placeholder = el.getAttribute("placeholder")?.toLowerCase() || "";
          const name = el.getAttribute("name")?.toLowerCase() || "";
          const id = el.id?.toLowerCase() || "";
          const label = el.getAttribute("aria-label")?.toLowerCase() || "";
          const lowerSel = sel.toLowerCase();
          return placeholder.includes(lowerSel) || name.includes(lowerSel) || id.includes(lowerSel) || label.includes(lowerSel);
        }) as HTMLInputElement | HTMLTextAreaElement;

        if (target) {
          target.focus();
          target.value = txt;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }, { sel: actualSelector, txt: text });

      if (typed) {
        return {
          success: true,
          message: `検索キー "${selector}" に合致する入力フィールドを見つけ出し、テキストを入力しました。`,
        };
      }
    } catch (evalErr) {
      console.error("[Interactive Browser] Smart type fallback evaluation error:", evalErr);
    }
    throw new Error(`要素 "${selector}" へのテキスト入力に失敗しました: ${err.message}`);
  }
}

/**
 * 指定時間、または特定要素が表示されるまで待機する
 */
export async function browserInteractiveWait(userId: string, selector?: string, timeoutMs: number = 5000): Promise<{ success: boolean; message: string }> {
  const { page } = await getInteractiveBrowser(userId);

  if (selector) {
    // 数値IDまたは "id:数字" 形式のセレクタを [data-yuuka-id="数値"] に変換
    let actualSelector = selector;
    if (/^\d+$/.test(selector.trim())) {
      actualSelector = `[data-yuuka-id="${selector.trim()}"]`;
    } else if (/^id:(\d+)$/i.test(selector.trim())) {
      const m = selector.trim().match(/^id:(\d+)$/i);
      actualSelector = `[data-yuuka-id="${m![1]}"]`;
    }

    await page.waitForSelector(actualSelector, { timeout: timeoutMs });
    return {
      success: true,
      message: `要素 "${actualSelector}" が出現するまで待機しました。`,
    };
  } else {
    await new Promise(r => setTimeout(r, timeoutMs));
    return {
      success: true,
      message: `${timeoutMs}ms 待機しました。`,
    };
  }
}

/**
 * 現在のブラウザセッションのアクティブなページ状態（URL、タイトル、スクリーンショット、マークダウン）を取得する
 */
export async function browserInteractiveStatus(userId: string): Promise<{
  success: boolean;
  url: string;
  title: string;
  imagePath: string;
  markdownContent: string;
}> {
  const { page } = await getInteractiveBrowser(userId);

  // DOMアノテーションを実行し、一時的な ID を付与する
  await annotateInteractiveElements(page);

  const title = await page.title();
  const url = page.url();
  
  // スクリーンショットの撮影と保存
  const filename = `interactive_screenshot_${Date.now()}.png`;
  const savePath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: savePath, fullPage: false });
  const relativeImagePath = path.relative(process.cwd(), savePath);

  // 非破壊的・かつインタラクティブ要素を含んだマークダウンの取得
  const markdownContent = await extractPageMarkdown(page, true);

  return {
    success: true,
    url,
    title: title || "無題のページ",
    imagePath: relativeImagePath,
    markdownContent: markdownContent.slice(0, 30000), // トークン節約のために拡張上限
  };
}

/**
 * インタラクティブブラウザセッションを明示的に終了する
 */
export async function browserInteractiveClose(userId: string): Promise<{ success: boolean; message: string }> {
  await closeInteractiveBrowser(userId);
  return {
    success: true,
    message: "ブラウザセッションを正常に終了しました。",
  };
}
