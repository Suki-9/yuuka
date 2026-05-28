import puppeteer from "puppeteer";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCREENSHOT_DIR = path.resolve(process.cwd(), "data/screenshots");

// スクリーンショット保存用ディレクトリの確保
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

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
      
      // 一般的なデスクトップ版 Chrome (Windows) の User-Agent を設定してボットブロックを低減
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      
      // 日本語優先のヘッダーを設定
      await page.setExtraHTTPHeaders({
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      });

      try {
        // タイムアウトを15秒に設定し、長引くトラッカー等を待たずに次に進めるようにする
        await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });
      } catch (gotoError: any) {
        // タイムアウトなどのナビゲーションエラーが発生しても、コンテンツが一部ロードされている可能性があるため続行
        console.warn(`Navigation timeout or error for ${url}, extracting content anyway: ${gotoError.message}`);
      }

      // ページのタイトルを取得
      const title = await page.title();

      // ESBuild/tsx の __name ヘルパーがブラウザ環境で未定義になるのを防ぐため、事前にグローバルに登録しておく
      try {
        await page.evaluate(() => {
          (window as any).__name = (fn: any) => fn;
        });
      } catch (err) {
        // 失敗しても無視して続行
      }

      // ブラウザ内でDOMを再帰的にパースし、クリーンなMarkdown表現に変換
      const rawMarkdown = await page.evaluate(() => {
        // 非表示要素を判別するヘルパー
        function isVisible(el: any) {
          if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          return true;
        }

        // 不要なタグを事前に削除してパース処理の無駄を省く
        const unwanted = document.querySelectorAll(
          "script, style, noscript, iframe, svg, img, header, footer, nav, link, meta, select, button, input, textarea, aside"
        );
        unwanted.forEach(el => el.remove());

        // クラス名・IDにノイズキーワードが含まれる要素も除去
        const noiseKeywords = ["footer", "nav", "sidebar", "menu", "ads"];
        const allElements = document.querySelectorAll("body *");
        allElements.forEach(el => {
          const id = el.id ? el.id.toLowerCase() : "";
          const className = el.className && typeof el.className === "string" ? el.className.toLowerCase() : "";
          
          const isNoise = noiseKeywords.some(keyword => id.includes(keyword) || className.includes(keyword));
          if (isNoise) {
            el.remove();
          }
        });

        // 再帰的DOMパース関数
        function traverse(node: any, isPre = false) {
          if (!node) return "";

          // 要素ノードの可視性チェック
          if (node.nodeType === Node.ELEMENT_NODE && !isVisible(node)) {
            return "";
          }

          // テキストノードの処理
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent || "";
            if (isPre) return text;
            // 連続する空白/タブ/改行を1つの半角スペースに圧縮
            return text.replace(/\s+/g, " ");
          }

          if (node.nodeType !== Node.ELEMENT_NODE) {
            return "";
          }

          const tagName = node.tagName.toLowerCase();

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

          // 通常の子ノード巡回
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
              // 無効なリンクやJavaScriptリンクは除外
              if (href && text && !href.startsWith("javascript:") && !href.startsWith("mailto:")) {
                return ` [${text}](${href}) `;
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
      });

      // 空行やインデントをクリーンアップ
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
      
      const markdown = cleanLines.join("\n").trim();

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
    const outputDir = path.resolve(process.cwd(), "data/debug_scrapes");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // 最新の取得結果を上書き保存
    const lastFetchPath = path.join(outputDir, "debug_last_fetch.md");
    fs.writeFileSync(lastFetchPath, result.markdown, "utf-8");
    
    // 履歴用ファイルとしてタイムスタンプ付きで保存
    const sanitizedUrl = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 100);
    const uniqueFilename = `fetch_${Date.now()}_${sanitizedUrl}.md`;
    const uniqueFetchPath = path.join(outputDir, uniqueFilename);
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
    // デスクトップの解像度に設定
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // TODO(security): ディレクトリトラバーサル防止のためにファイル名をサニタイズ
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
  // まず Rust クローラーによる高速検索を試みる
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

    // まずは Google 検索を試みる
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    try {
      await page.goto(googleUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
      
      const googleResults = await page.evaluate(() => {
        const items: Array<{ title: string; url: string; snippet: string }> = [];
        // Googleの検索結果コンテナ div.g
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
        return googleResults.slice(0, 8); // 上位8件を返す
      }
    } catch (e: any) {
      console.warn(`Google Search failed or timed out: ${e.message}. Falling back to DuckDuckGo...`);
    }

    // Googleが失敗するか結果が0件の場合は DuckDuckGo (HTML版) を使用してフォールバック
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
