use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::env;
use std::error::Error;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::sleep;

#[derive(Serialize, Debug, Clone)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

#[derive(Debug, Clone)]
struct ScoredResult {
    title: String,
    url: String,
    snippet: String,
    rrf_score: f64,
    authority_score: f64,
    keyword_score: f64,
    final_score: f64,
}

// ─── Daemon IPC プロトコル ────────────────────────────────────────────────────
// Request:  {"id":1,"command":"fetch"|"search"|"fetch-js"|"screenshot","target":"...","extra":"..."}
// Response: {"id":1,"ok":true,"result":"..."} or {"id":1,"ok":false,"error":"..."}

#[derive(Deserialize)]
struct DaemonRequest {
    id: u64,
    command: String,
    target: String,
    extra: Option<String>, // screenshot の output_path など
}

#[derive(Serialize)]
struct DaemonResponse {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  yuuka-crawler daemon");
        eprintln!("  yuuka-crawler fetch <url>");
        eprintln!("  yuuka-crawler fetch-js <url>");
        eprintln!("  yuuka-crawler search <query>");
        eprintln!("  yuuka-crawler screenshot <url> <output_path>");
        std::process::exit(1);
    }

    let command = &args[1];

    match command.as_str() {
        "daemon" => {
            run_daemon().await?;
        }
        "fetch" => {
            if args.len() < 3 { eprintln!("Usage: yuuka-crawler fetch <url>"); std::process::exit(1); }
            match fetch_to_string(&args[2]).await {
                Ok(s) => println!("{}", s),
                Err(e) => { eprintln!("Fetch error: {}", e); std::process::exit(1); }
            }
        }
        "fetch-js" => {
            if args.len() < 3 { eprintln!("Usage: yuuka-crawler fetch-js <url>"); std::process::exit(1); }
            match fetch_js_to_string(&args[2]).await {
                Ok(s) => println!("{}", s),
                Err(e) => { eprintln!("Fetch-JS error: {}", e); std::process::exit(1); }
            }
        }
        "search" => {
            if args.len() < 3 { eprintln!("Usage: yuuka-crawler search <query>"); std::process::exit(1); }
            match search_to_string(&args[2]).await {
                Ok(s) => println!("{}", s),
                Err(e) => { eprintln!("Search error: {}", e); std::process::exit(1); }
            }
        }
        "screenshot" => {
            if args.len() < 4 { eprintln!("Usage: yuuka-crawler screenshot <url> <output_path>"); std::process::exit(1); }
            if let Err(e) = run_screenshot(&args[2], &args[3]).await {
                eprintln!("Screenshot error: {}", e);
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            std::process::exit(1);
        }
    }

    Ok(())
}

// ─── DAEMON モード ────────────────────────────────────────────────────────────

async fn run_daemon() -> Result<(), Box<dyn Error>> {
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<DaemonRequest>(&line) {
            Err(e) => DaemonResponse {
                id: 0,
                ok: false,
                result: None,
                error: Some(format!("JSON parse error: {}", e)),
            },
            Ok(req) => {
                let id = req.id;
                match req.command.as_str() {
                    "fetch" => match fetch_to_string(&req.target).await {
                        Ok(r) => DaemonResponse { id, ok: true, result: Some(r), error: None },
                        Err(e) => DaemonResponse { id, ok: false, result: None, error: Some(e.to_string()) },
                    },
                    "fetch-js" => match fetch_js_to_string(&req.target).await {
                        Ok(r) => DaemonResponse { id, ok: true, result: Some(r), error: None },
                        Err(e) => DaemonResponse { id, ok: false, result: None, error: Some(e.to_string()) },
                    },
                    "search" => match search_to_string(&req.target).await {
                        Ok(r) => DaemonResponse { id, ok: true, result: Some(r), error: None },
                        Err(e) => DaemonResponse { id, ok: false, result: None, error: Some(e.to_string()) },
                    },
                    "screenshot" => {
                        let output_path = req.extra.as_deref().unwrap_or("");
                        if output_path.is_empty() {
                            DaemonResponse { id, ok: false, result: None, error: Some("screenshot requires extra (output_path)".to_string()) }
                        } else {
                            match run_screenshot(&req.target, output_path).await {
                                Ok(()) => DaemonResponse { id, ok: true, result: Some(output_path.to_string()), error: None },
                                Err(e) => DaemonResponse { id, ok: false, result: None, error: Some(e.to_string()) },
                            }
                        }
                    }
                    other => DaemonResponse {
                        id,
                        ok: false,
                        result: None,
                        error: Some(format!("Unknown command: {}", other)),
                    },
                }
            }
        };

        let json = serde_json::to_string(&response)?;
        stdout.write_all(format!("{}\n", json).as_bytes()).await?;
        stdout.flush().await?;
    }

    Ok(())
}

// ─── Chrome実行ファイルの探索 ────────────────────────────────────────────────

fn find_chrome_executable() -> Result<String, Box<dyn Error>> {
    if let Ok(path) = env::var("CHROME_EXECUTABLE_PATH") {
        if Path::new(&path).exists() {
            return Ok(path);
        }
    }

    let common_paths = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/usr/local/bin/google-chrome",
        "/snap/bin/chromium",
        "/usr/bin/google-chrome-beta",
    ];

    for path in &common_paths {
        if Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    if let Ok(home) = env::var("HOME") {
        let puppeteer_base = Path::new(&home).join(".cache/puppeteer/chrome");
        if let Ok(entries) = std::fs::read_dir(&puppeteer_base) {
            for entry in entries.filter_map(|e| e.ok()) {
                let chrome_path = entry.path().join("chrome-linux64/chrome");
                if chrome_path.exists() {
                    return Ok(chrome_path.to_string_lossy().to_string());
                }
                let chrome_path_old = entry.path().join("chrome-linux/chrome");
                if chrome_path_old.exists() {
                    return Ok(chrome_path_old.to_string_lossy().to_string());
                }
            }
        }
    }

    Err("Chrome実行ファイルが見つかりません。CHROME_EXECUTABLE_PATH環境変数を設定するか、Chromeをインストールしてください。".into())
}

// ─── SCREENSHOT 機能 ─────────────────────────────────────────────────────────

async fn run_screenshot(url: &str, output_path: &str) -> Result<(), Box<dyn Error>> {
    let chrome = find_chrome_executable()?;

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    let temp_dir = env::temp_dir().join(format!("yuuka-screenshot-{}", timestamp));
    std::fs::create_dir_all(&temp_dir)?;

    let output = tokio::process::Command::new(&chrome)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-software-rasterizer",
            "--hide-scrollbars",
            "--window-size=1280,800",
            "--screenshot",
            url,
        ])
        .current_dir(&temp_dir)
        .output()
        .await?;

    let screenshot_temp = temp_dir.join("screenshot.png");

    if screenshot_temp.exists() {
        std::fs::copy(&screenshot_temp, output_path)?;
        std::fs::remove_dir_all(&temp_dir).ok();
        eprintln!("Screenshot saved: {}", output_path);
        Ok(())
    } else {
        std::fs::remove_dir_all(&temp_dir).ok();
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "スクリーンショットファイルが生成されませんでした。Chrome出力:\n{}",
            stderr
        )
        .into())
    }
}

// ─── FETCH-JS 機能（Chrome --dump-dom によるJSレンダリング済みコンテンツ取得） ──────

async fn fetch_js_to_string(url: &str) -> Result<String, Box<dyn Error>> {
    let chrome = find_chrome_executable()?;

    let output = tokio::process::Command::new(&chrome)
        .args([
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--dump-dom",
            "--timeout=12000",
            url,
        ])
        .output()
        .await?;

    let html = String::from_utf8_lossy(&output.stdout).to_string();

    if html.trim().is_empty() {
        return Err("Chrome dump-dom が空のコンテンツを返しました。".into());
    }

    let document = Html::parse_document(&html);

    let title_selector = Selector::parse("title").unwrap();
    let title = if let Some(title_el) = document.select(&title_selector).next() {
        title_el.text().collect::<Vec<_>>().join(" ").trim().to_string()
    } else {
        "無題のページ".to_string()
    };

    let root = document.tree.root();
    let raw_markdown = traverse(root, false);
    let mut markdown = clean_markdown(&raw_markdown);

    if !title.is_empty() && title != "無題のページ" {
        markdown = format!("# {}\n\n{}", title, markdown);
    }

    if markdown.trim().len() < 100 {
        return Err("JSレンダリング後のコンテンツが極端に短いか空です。".into());
    }

    Ok(markdown)
}

// ─── FETCH 機能 ───────────────────────────────────────────────────────────────

async fn fetch_to_string(url: &str) -> Result<String, Box<dyn Error>> {
    let html = fetch_html_with_retry(url).await?;
    let document = Html::parse_document(&html);

    let title_selector = Selector::parse("title").unwrap();
    let title = if let Some(title_el) = document.select(&title_selector).next() {
        title_el.text().collect::<Vec<_>>().join(" ").trim().to_string()
    } else {
        "無題のページ".to_string()
    };

    let root = document.tree.root();
    let raw_markdown = traverse(root, false);
    let mut markdown = clean_markdown(&raw_markdown);

    if !title.is_empty() && title != "無題のページ" {
        markdown = format!("# {}\n\n{}", title, markdown);
    }

    if markdown.trim().len() < 100 {
        return Err("Fetched content is extremely short or empty (possibly JS-only or blocked).".into());
    }

    Ok(markdown)
}

fn clean_markdown(s: &str) -> String {
    let mut lines = Vec::new();
    let mut consecutive_empty = 0;
    let mut in_code_block = false;

    for line in s.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.starts_with("```") {
            in_code_block = !in_code_block;
            consecutive_empty = 0;
            lines.push(trimmed_line.to_string());
            continue;
        }

        if in_code_block {
            lines.push(line.to_string());
            consecutive_empty = 0;
        } else {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                consecutive_empty += 1;
                if consecutive_empty <= 1 {
                    lines.push("".to_string());
                }
            } else {
                consecutive_empty = 0;
                lines.push(trimmed.to_string());
            }
        }
    }

    lines.join("\n").trim().to_string()
}

fn compress_whitespace(s: &str) -> String {
    let mut result = String::new();
    let mut last_was_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_was_space {
                result.push(' ');
                last_was_space = true;
            }
        } else {
            result.push(c);
            last_was_space = false;
        }
    }
    result
}

fn traverse(node: ego_tree::NodeRef<scraper::node::Node>, is_pre: bool) -> String {
    let node_data = node.value();

    if !node_data.is_element() && !node_data.is_text() {
        let mut children_text = String::new();
        for child in node.children() {
            children_text.push_str(&traverse(child, is_pre));
        }
        return children_text;
    }

    if node_data.is_element() {
        let el = node_data.as_element().unwrap();
        let tag_name = el.name().to_lowercase();

        let unwanted_tags = [
            "script", "style", "noscript", "iframe", "svg", "img", "header", "footer", "nav",
            "link", "meta", "select", "button", "input", "textarea", "aside",
        ];
        if unwanted_tags.contains(&tag_name.as_str()) {
            return "".to_string();
        }

        let mut is_noise = false;
        if let Some(class_val) = el.attr("class") {
            let class_lower = class_val.to_lowercase();
            if class_lower.contains("footer") || class_lower.contains("nav") ||
               class_lower.contains("sidebar") || class_lower.contains("menu") ||
               class_lower.contains("ads") || class_lower.contains("advertisement") ||
               class_lower.contains("cookie") || class_lower.contains("popup") ||
               class_lower.contains("modal") || class_lower.contains("overlay") ||
               class_lower.contains("banner") || class_lower.contains("promo") {
                is_noise = true;
            }
        }
        if let Some(id_val) = el.attr("id") {
            let id_lower = id_val.to_lowercase();
            if id_lower.contains("footer") || id_lower.contains("nav") ||
               id_lower.contains("sidebar") || id_lower.contains("menu") ||
               id_lower.contains("ads") || id_lower.contains("advertisement") ||
               id_lower.contains("cookie") || id_lower.contains("popup") ||
               id_lower.contains("modal") || id_lower.contains("overlay") {
                is_noise = true;
            }
        }
        if let Some(aria_hidden) = el.attr("aria-hidden") {
            if aria_hidden == "true" {
                return "".to_string();
            }
        }
        if is_noise {
            return "".to_string();
        }

        let style_str: &str = el.attr("style").unwrap_or("");
        if !style_str.is_empty() {
            let s = style_str.to_lowercase();
            if s.contains("display:none") || s.contains("display: none") ||
               s.contains("visibility:hidden") || s.contains("visibility: hidden") {
                return "".to_string();
            }
        }

        let is_next_pre = is_pre || tag_name == "pre" || tag_name == "code";
        let mut children_text = String::new();
        for child in node.children() {
            children_text.push_str(&traverse(child, is_next_pre));
        }

        match tag_name.as_str() {
            "h1" => format!("\n\n# {}\n\n", children_text.trim()),
            "h2" => format!("\n\n## {}\n\n", children_text.trim()),
            "h3" => format!("\n\n### {}\n\n", children_text.trim()),
            "h4" | "h5" | "h6" => format!("\n\n#### {}\n\n", children_text.trim()),
            "p" => format!("\n\n{}\n\n", children_text.trim()),
            "br" => "\n".to_string(),
            "hr" => "\n\n---\n\n".to_string(),
            "a" => {
                let href = el.attr("href").unwrap_or("").trim();
                let text = children_text.trim();
                if !href.is_empty() && !text.is_empty() && !href.starts_with("javascript:") && !href.starts_with("mailto:") {
                    format!(" [{}]({}) ", text, href)
                } else {
                    children_text
                }
            }
            "li" => format!("\n- {}", children_text.trim()),
            "ul" | "ol" => format!("\n{}\n", children_text),
            "th" | "td" => {
                let cell_text = children_text.replace('\n', " ").replace('\r', " ");
                let trimmed = cell_text.trim();
                let compressed = compress_whitespace(trimmed);
                format!(" {} |", compressed)
            }
            "tr" => format!("\n|{}", children_text),
            "thead" | "tbody" | "table" => format!("\n\n{}\n\n", children_text),
            "pre" => format!("\n```\n{}\n```\n", children_text.trim()),
            "code" => {
                if is_pre {
                    children_text
                } else {
                    format!(" `{}` ", children_text.trim())
                }
            }
            _ => {
                let is_block = ["div", "section", "article", "main", "body", "blockquote", "form"].contains(&tag_name.as_str());
                if is_block {
                    format!("\n{}\n", children_text)
                } else {
                    children_text
                }
            }
        }
    } else if node_data.is_text() {
        let text = node_data.as_text().unwrap();
        if is_pre {
            text.to_string()
        } else {
            compress_whitespace(text)
        }
    } else {
        "".to_string()
    }
}

// ─── SEARCH 機能 ──────────────────────────────────────────────────────────────

async fn search_to_string(query: &str) -> Result<String, Box<dyn Error>> {
    let google_url = format!("https://www.google.com/search?q={}", urlencoding::encode(query));
    let ddg_url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding::encode(query));

    let (google_res, ddg_res) = tokio::join!(
        fetch_html_with_retry(&google_url),
        fetch_html_with_retry(&ddg_url)
    );

    let google_results = match google_res {
        Ok(html) => parse_google_results(&html),
        Err(e) => {
            eprintln!("Google Search failed: {}", e);
            Vec::new()
        }
    };

    let ddg_results = match ddg_res {
        Ok(html) => parse_ddg_results(&html),
        Err(e) => {
            eprintln!("DuckDuckGo Search failed: {}", e);
            Vec::new()
        }
    };

    if google_results.is_empty() && ddg_results.is_empty() {
        return Err("No results found in both Google and DuckDuckGo.".into());
    }

    let merged_results = merge_and_rank_results(query, google_results, ddg_results);

    if merged_results.is_empty() {
        return Err("All results were filtered out or empty.".into());
    }

    Ok(serde_json::to_string(&merged_results)?)
}

fn merge_and_rank_results(
    query: &str,
    google_results: Vec<SearchResult>,
    ddg_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
    use std::collections::HashMap;

    let mut scored_map: HashMap<String, ScoredResult> = HashMap::new();
    let k = 60.0;

    for (i, res) in google_results.into_iter().enumerate() {
        let rank = (i + 1) as f64;
        let rrf_score = 1.0 / (k + rank);
        let key = res.url.clone();
        scored_map.insert(key, ScoredResult {
            title: res.title,
            url: res.url,
            snippet: res.snippet,
            rrf_score,
            authority_score: 0.0,
            keyword_score: 0.0,
            final_score: 0.0,
        });
    }

    for (i, res) in ddg_results.into_iter().enumerate() {
        let rank = (i + 1) as f64;
        let rrf_score = 1.0 / (k + rank);
        let key = res.url.clone();

        if let Some(existing) = scored_map.get_mut(&key) {
            existing.rrf_score += rrf_score;
        } else {
            scored_map.insert(key, ScoredResult {
                title: res.title,
                url: res.url,
                snippet: res.snippet,
                rrf_score,
                authority_score: 0.0,
                keyword_score: 0.0,
                final_score: 0.0,
            });
        }
    }

    let mut results: Vec<ScoredResult> = scored_map.into_values().collect();

    for doc in &mut results {
        doc.authority_score = evaluate_authority(&doc.url);
        doc.keyword_score = evaluate_keyword_relevance(query, &doc.title, &doc.snippet);
        doc.final_score = doc.rrf_score + (doc.authority_score * 0.02) + (doc.keyword_score * 0.01);
    }

    results.retain(|doc| doc.authority_score > -0.9);
    results.sort_by(|a, b| b.final_score.partial_cmp(&a.final_score).unwrap_or(std::cmp::Ordering::Equal));

    results.into_iter().map(|doc| SearchResult {
        title: doc.title,
        url: doc.url,
        snippet: doc.snippet,
    }).take(8).collect()
}

fn evaluate_authority(url: &str) -> f64 {
    let url_lower = url.to_lowercase();
    let mut score = 0.0;

    if url_lower.contains(".go.jp") || url_lower.contains("jma.go.jp") {
        score += 1.0;
    } else if url_lower.contains(".ac.jp") || url_lower.contains(".edu") {
        score += 0.5;
    } else if url_lower.contains(".or.jp") || url_lower.contains(".org") {
        score += 0.3;
    }

    let trusted_sources = [
        "itmedia.co.jp", "impress.co.jp", "nikkei.com", "asahi.com", "yomiuri.co.jp",
        "mainichi.jp", "nhk.or.jp", "wikipedia.org", "github.com", "microsoft.com",
        "transit.yahoo.co.jp", "weather.yahoo.co.jp", "jma.go.jp",
    ];
    for source in &trusted_sources {
        if url_lower.contains(source) {
            score += 0.6;
        }
    }

    let spam_keywords = [
        "matome", "blog.jp", "livedoor.biz", "2ch", "5ch", "geha", "affiliate",
        "hachima", "jin115", "matomedane", "togetter",
    ];
    for keyword in &spam_keywords {
        if url_lower.contains(keyword) {
            score -= 1.0;
        }
    }

    score
}

fn evaluate_keyword_relevance(query: &str, title: &str, snippet: &str) -> f64 {
    let title_lower = title.to_lowercase();
    let snippet_lower = snippet.to_lowercase();
    let query_lower = query.to_lowercase();

    let words: Vec<&str> = query_lower.split_whitespace().collect();
    if words.is_empty() {
        return 0.0;
    }

    let mut match_count = 0.0;
    for word in &words {
        if title_lower.contains(word) {
            match_count += 2.0;
        }
        if snippet_lower.contains(word) {
            match_count += 1.0;
        }
    }

    match_count / (words.len() as f64)
}

fn parse_google_results(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let document = Html::parse_document(html);

    let container_selector = Selector::parse("div.g").unwrap();
    let title_selector = Selector::parse("h3").unwrap();
    let anchor_selector = Selector::parse("a").unwrap();

    let snippet_selectors = [
        Selector::parse("div.VwiC3b").unwrap(),
        Selector::parse("span.aCOpbc").unwrap(),
        Selector::parse("div.yD3zGc").unwrap(),
    ];

    for container in document.select(&container_selector) {
        if let Some(title_el) = container.select(&title_selector).next() {
            if let Some(anchor) = container.select(&anchor_selector).next() {
                let title = title_el.text().collect::<Vec<_>>().join(" ").trim().to_string();
                let url = anchor.attr("href").unwrap_or("").to_string();

                let mut snippet = String::new();
                for sel in &snippet_selectors {
                    if let Some(snippet_el) = container.select(sel).next() {
                        snippet = snippet_el.text().collect::<Vec<_>>().join(" ").trim().to_string();
                        if !snippet.is_empty() {
                            break;
                        }
                    }
                }

                if !title.is_empty() && !url.is_empty() {
                    results.push(SearchResult { title, url, snippet });
                }
            }
        }
    }

    results.truncate(8);
    results
}

fn parse_ddg_results(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let document = Html::parse_document(html);

    let container_selector = Selector::parse(".result").unwrap();
    let title_link_selector = Selector::parse(".result__title a").unwrap();
    let snippet_selector = Selector::parse(".result__snippet").unwrap();

    for container in document.select(&container_selector) {
        if let Some(link_el) = container.select(&title_link_selector).next() {
            let title = link_el.text().collect::<Vec<_>>().join(" ").trim().to_string();
            let url = link_el.attr("href").unwrap_or("").to_string();

            let snippet = if let Some(snippet_el) = container.select(&snippet_selector).next() {
                snippet_el.text().collect::<Vec<_>>().join(" ").trim().to_string()
            } else {
                "".to_string()
            };

            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult { title, url, snippet });
            }
        }
    }

    results.truncate(8);
    results
}

// ─── HTTP GET クライアント（ブラウザに近いヘッダー・指数バックオフ付きリトライ） ──────

async fn fetch_html_with_retry(url: &str) -> Result<String, Box<dyn Error>> {
    let client = reqwest::Client::builder()
        .gzip(true)
        .brotli(true)
        .deflate(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()?;

    let mut delay = Duration::from_secs(1);
    let max_retries = 3;
    let mut last_err = "Failed to fetch page".to_string();

    for i in 0..max_retries {
        let request = client.get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
            .header("Accept-Language", "ja,en-US;q=0.9,en;q=0.8")
            .header("Accept-Encoding", "gzip, deflate, br")
            .header("Cache-Control", "no-cache")
            .header("Pragma", "no-cache")
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "none")
            .header("Sec-Fetch-User", "?1")
            .header("Upgrade-Insecure-Requests", "1")
            .timeout(Duration::from_secs(15));

        match request.send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let text = response.text().await?;
                    return Ok(text);
                } else {
                    last_err = format!("Server returned status code {}", status);
                    eprintln!("Attempt {} failed: {}", i + 1, last_err);

                    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
                        return Err(last_err.into());
                    }
                }
            }
            Err(e) => {
                last_err = format!("Request error: {}", e);
                eprintln!("Attempt {} failed: {}", i + 1, last_err);
            }
        }

        if i < max_retries - 1 {
            sleep(delay).await;
            delay *= 2;
        }
    }

    Err(last_err.into())
}
