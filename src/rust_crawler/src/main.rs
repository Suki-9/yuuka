use scraper::{Html, Selector};
use serde::Serialize;
use std::env;
use std::error::Error;
use std::time::Duration;
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
    let google_url = format!("https://www.google.com/search?q={}", urlencoding::encode(query));
    let ddg_url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding::encode(query));

    // GoogleとDuckDuckGoの検索を非同期で並行実行
    let google_future = fetch_html_with_retry(&google_url);
    let ddg_future = fetch_html_with_retry(&ddg_url);

    let (google_res, ddg_res) = tokio::join!(google_future, ddg_future);

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

    // RRFマージ、権威性フィルタ、キーワードブーストを適用して再ランク付け
    let merged_results = merge_and_rank_results(query, google_results, ddg_results);

    if merged_results.is_empty() {
        return Err("All results were filtered out or empty.".into());
    }

    let json_output = serde_json::to_string(&merged_results)?;
    println!("{}", json_output);
    Ok(())
}

fn merge_and_rank_results(
    query: &str,
    google_results: Vec<SearchResult>,
    ddg_results: Vec<SearchResult>,
) -> Vec<SearchResult> {
    use std::collections::HashMap;

    let mut scored_map: HashMap<String, ScoredResult> = HashMap::new();
    let k = 60.0;

    // Google結果のRRFスコアリング
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

    // DuckDuckGo結果のRRFスコアリングと統合
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
    
    // 権威性およびキーワード密度による追加スコアリング
    for doc in &mut results {
        doc.authority_score = evaluate_authority(&doc.url);
        doc.keyword_score = evaluate_keyword_relevance(query, &doc.title, &doc.snippet);
        
        // 最終スコアの合成
        // rrf_score: 0.016〜0.033
        // authority_score: -1.0 〜 1.0
        // keyword_score: 0.0 〜 3.0
        doc.final_score = doc.rrf_score + (doc.authority_score * 0.02) + (doc.keyword_score * 0.01);
    }
    
    // スパム判定された低品質ドメインの除外 (-0.9未満は切り捨て)
    results.retain(|doc| doc.authority_score > -0.9);

    // 最終スコアで降順ソート
    results.sort_by(|a, b| b.final_score.partial_cmp(&a.final_score).unwrap_or(std::cmp::Ordering::Equal));

    // SearchResultの型に戻して最大8件を返す
    results.into_iter().map(|doc| SearchResult {
        title: doc.title,
        url: doc.url,
        snippet: doc.snippet,
    }).take(8).collect()
}

fn evaluate_authority(url: &str) -> f64 {
    let url_lower = url.to_lowercase();
    let mut score = 0.0;

    // 1. 公式および公的機関のドメイン（強加点）
    if url_lower.contains(".go.jp") || url_lower.contains("jma.go.jp") {
        score += 1.0;
    } else if url_lower.contains(".ac.jp") || url_lower.contains(".edu") {
        score += 0.5;
    } else if url_lower.contains(".or.jp") || url_lower.contains(".org") {
        score += 0.3;
    }

    // 2. 信頼できる一次ソース・大手ドメインへの加点
    let trusted_sources = [
        "itmedia.co.jp", "impress.co.jp", "nikkei.com", "asahi.com", "yomiuri.co.jp", 
        "mainichi.jp", "nhk.or.jp", "wikipedia.org", "github.com", "microsoft.com", 
        "transit.yahoo.co.jp", "weather.yahoo.co.jp", "jma.go.jp"
    ];
    for source in &trusted_sources {
        if url_lower.contains(source) {
            score += 0.6;
        }
    }

    // 3. まとめサイト、アフィリエイト、2ch/5ch転載、スパムドメインへの減点
    let spam_keywords = [
        "matome", "blog.jp", "livedoor.biz", "2ch", "5ch", "geha", "affiliate",
        "hachima", "jin115", "matomedane", "togetter"
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
            match_count += 2.0; // タイトル内ヒットを重視
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

