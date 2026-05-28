use scraper::{Html, Selector};
use serde::Serialize;
use std::env;
use std::error::Error;
use std::time::Duration;
use tokio::time::sleep;

#[derive(Serialize, Debug)]
struct SearchResult {
    title: String,
    url: String,
    snippet: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage:");
        eprintln!("  yuuka-crawler fetch <url>");
        eprintln!("  yuuka-crawler search <query>");
        std::process::exit(1);
    }

    let command = &args[1];
    let target = &args[2];

    match command.as_str() {
        "fetch" => {
            if let Err(e) = run_fetch(target).await {
                eprintln!("Fetch error: {}", e);
                std::process::exit(1);
            }
        }
        "search" => {
            if let Err(e) = run_search(target).await {
                eprintln!("Search error: {}", e);
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

// ─── FETCH 機能 ────────────────────────────────────────────────────────

async fn run_fetch(url: &str) -> Result<(), Box<dyn Error>> {
    let html = fetch_html_with_retry(url).await?;
    let document = Html::parse_document(&html);
    
    // ページの <title> タグからタイトルを抽出
    let title_selector = Selector::parse("title").unwrap();
    let title = if let Some(title_el) = document.select(&title_selector).next() {
        title_el.text().collect::<Vec<_>>().join(" ").trim().to_string()
    } else {
        "無題のページ".to_string()
    };
    
    // DOMを再帰的にトラバースしてMarkdownにパース
    let root = document.tree.root();
    let raw_markdown = traverse(root, false);
    
    // 空行やインデントをクリーンアップ
    let mut markdown = clean_markdown(&raw_markdown);
    
    if !title.is_empty() && title != "無題のページ" {
        markdown = format!("# {}\n\n{}", title, markdown);
    }
    
    if markdown.trim().len() < 100 {
        return Err("Fetched content is extremely short or empty (possibly JS-only or blocked).".into());
    }

    println!("{}", markdown);
    Ok(())
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
        
        // 不要なタグを除外
        let unwanted_tags = [
            "script", "style", "noscript", "iframe", "svg", "img", "header", "footer", "nav",
            "link", "meta", "select", "button", "input", "textarea", "aside"
        ];
        if unwanted_tags.contains(&tag_name.as_str()) {
            return "".to_string();
        }
        
        // クラス名・ID名によるノイズ判定
        let mut is_noise = false;
        if let Some(class_val) = el.attr("class") {
            let class_lower = class_val.to_lowercase();
            if class_lower.contains("footer") || class_lower.contains("nav") || 
               class_lower.contains("sidebar") || class_lower.contains("menu") || 
               class_lower.contains("ads") {
                is_noise = true;
            }
        }
        if let Some(id_val) = el.attr("id") {
            let id_lower = id_val.to_lowercase();
            if id_lower.contains("footer") || id_lower.contains("nav") || 
               id_lower.contains("sidebar") || id_lower.contains("menu") || 
               id_lower.contains("ads") {
                is_noise = true;
            }
        }
        if is_noise {
            return "".to_string();
        }
        
        // 非表示の要素を判別 (style="display:none"等)
        let style_str: &str = el.attr("style").unwrap_or("");
        if !style_str.is_empty() {
            let s = style_str.to_lowercase();
            if s.contains("display:none") || s.contains("display: none") || 
               s.contains("visibility:hidden") || s.contains("visibility: hidden") {
                return "".to_string();
            }
        }
        
        // 子ノード巡回
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

// ─── SEARCH 機能 ────────────────────────────────────────────────────────

async fn run_search(query: &str) -> Result<(), Box<dyn Error>> {
    // まず Google 検索を試みる
    let google_url = format!("https://www.google.com/search?q={}", urlencoding::encode(query));
    
    match fetch_html_with_retry(&google_url).await {
        Ok(html) => {
            let results = parse_google_results(&html);
            if !results.is_empty() {
                let json_output = serde_json::to_string(&results)?;
                println!("{}", json_output);
                return Ok(());
            }
            eprintln!("Google returned 0 results. Falling back to DuckDuckGo...");
        }
        Err(e) => {
            eprintln!("Google Search failed: {}. Falling back to DuckDuckGo...", e);
        }
    }

    // Googleが失敗または結果0件の場合、DuckDuckGo (HTML版) にフォールバック
    let ddg_url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding::encode(query));
    let html = fetch_html_with_retry(&ddg_url).await?;
    let results = parse_ddg_results(&html);
    
    if results.is_empty() {
        return Err("No results found in Google and DuckDuckGo.".into());
    }

    let json_output = serde_json::to_string(&results)?;
    println!("{}", json_output);
    Ok(())
}

fn parse_google_results(html: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let document = Html::parse_document(html);
    
    // div.g はGoogleの検索結果のコンテナ
    let container_selector = Selector::parse("div.g").unwrap();
    let title_selector = Selector::parse("h3").unwrap();
    let anchor_selector = Selector::parse("a").unwrap();
    
    // スニペット用の一般的なクラス群
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
                
                // スニペットの抽出
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

// ─── HTTP GET クライアント（指数バックオフ付きリトライ） ───────────────────────

async fn fetch_html_with_retry(url: &str) -> Result<String, Box<dyn Error>> {
    let client = reqwest::Client::builder()
        .gzip(true)
        .build()?;
    
    let mut delay = Duration::from_secs(1);
    let max_retries = 3;
    let mut last_err = "Failed to fetch page".to_string();

    for i in 0..max_retries {
        let request = client.get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept-Language", "ja,en-US;q=0.9,en;q=0.8")
            .timeout(Duration::from_secs(10));
            
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    let text = response.text().await?;
                    return Ok(text);
                } else {
                    last_err = format!("Server returned status code {}", status);
                    eprintln!("Attempt {} failed: {}", i + 1, last_err);
                    
                    // 403や401などの認証/アクセス制限系エラーの場合はリトライせず即時終了してフォールバックする
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
