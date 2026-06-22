// ─────────────────────────────────────────────────────────────────────────────
//  yuuka-synapse — 常駐シナプスエンジン
// ─────────────────────────────────────────────────────────────────────────────
//
//  architecture_renewal_v3.md の「Rust シナプスエンジン（新規・常駐）」の実体。
//  記憶の重い処理（埋め込み生成・RAM ベクトル索引・近傍探索）を **V8 ヒープの外**
//  へ追い出すための独立プロセス。Node の子プロセスとして起動され、crawler と同じ
//  「改行区切り JSON を stdin/stdout でやり取りする」デーモン流儀に従う。
//
//  使い方:
//    yuuka-synapse daemon --db <path> [--dim <N>]
//  --db 省略時は環境変数 YUUKA_DB_PATH、それも無ければ ./data/yuuka.db。
// ─────────────────────────────────────────────────────────────────────────────

mod embedder;
mod index;
mod storage;

use std::env;
use std::error::Error;

use base64::Engine as _Base64Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use embedder::{Embedder, HashNgramEmbedder};
use index::{vector_to_le_bytes, Entry, Scope, SynapseIndex};

// ─── Daemon IPC プロトコル（凍結・Node クライアントと厳密一致） ─────────────────
// Request:  {"id": <u64>, "command": <string>, ...fields}
// Response: {"id": <u64>, "ok": <bool>, "result": <object|null>, "error": <string|null>}
//
// "id" は純粋な「封筒(envelope)＝リクエスト相関 ID」であり、クライアントは res.id で
// 元のリクエストへ照合する。応答ではこの id をそのままエコーする。
// シナプス ID は封筒 id と衝突させないため、index/forget では **別キー "sid"** で運ぶ
// （Node クライアントは {...fields, id, command} の順で送り、封筒 id/command が常に勝つ）。
// 本実装は1行を Value としてパースし、トップレベルから id/command を読みつつ、
// 同じ Value からコマンド固有フィールド（sid 等）を取り出す。
struct DaemonRequest {
    id: u64,
    command: String,
    /// リクエスト全体（id/command を含む生の JSON オブジェクト）。
    raw: Value,
}

impl DaemonRequest {
    /// 1行の JSON 文字列をパース。id は必須・整数、command は必須・文字列。
    fn parse(line: &str) -> Result<DaemonRequest, String> {
        let raw: Value =
            serde_json::from_str(line).map_err(|e| format!("JSON parse error: {}", e))?;
        let obj = raw
            .as_object()
            .ok_or_else(|| "JSON parse error: トップレベルがオブジェクトではありません".to_string())?;
        let id = obj
            .get("id")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "JSON parse error: id（u64）がありません".to_string())?;
        let command = obj
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "JSON parse error: command（string）がありません".to_string())?
            .to_string();
        Ok(DaemonRequest { id, command, raw })
    }
}

#[derive(Serialize)]
struct DaemonResponse {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl DaemonResponse {
    fn ok(id: u64, result: Value) -> Self {
        DaemonResponse {
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }
    fn err(id: u64, msg: impl Into<String>) -> Self {
        DaemonResponse {
            id,
            ok: false,
            result: None,
            error: Some(msg.into()),
        }
    }
}

// ─── 受信ペイロード（serde で extra から取り出す型たち） ─────────────────────────

#[derive(Deserialize)]
struct ScopeIn {
    user_id: String,
    bot_id: String,
    #[serde(default)]
    guild_id: Option<String>,
}

impl From<ScopeIn> for Scope {
    fn from(s: ScopeIn) -> Self {
        Scope {
            user_id: s.user_id,
            bot_id: s.bot_id,
            guild_id: s.guild_id,
        }
    }
}

#[derive(Deserialize)]
struct AssembleReq {
    scope: ScopeIn,
    query: String,
    #[serde(default = "default_k")]
    k: usize,
}
fn default_k() -> usize {
    5
}

#[derive(Deserialize)]
struct IndexReq {
    sid: i64, // シナプス ID（封筒 id とは別キー。§プロトコル参照）
    scope: ScopeIn,
    #[serde(default)]
    topic_id: Option<String>,
    content: String,
}

#[derive(Deserialize)]
struct ForgetReq {
    sid: i64, // 削除対象のシナプス ID
}

// ─── エンジン本体（索引＋埋め込み器を1つの所有構造に） ───────────────────────────

struct Engine {
    embedder: Box<dyn Embedder>,
    index: SynapseIndex,
    db_path: String,
}

impl Engine {
    /// 起動時：read-only で DB を読み索引を構築。失敗しても空索引で続行（panic 厳禁）。
    fn boot(db_path: String, dim: usize) -> Self {
        let embedder: Box<dyn Embedder> = make_embedder(dim);

        let index = match storage::load_index(&db_path, embedder.as_ref()) {
            Ok((idx, loaded)) => {
                eprintln!(
                    "[synapse] 起動: DB から {} 件のシナプスを RAM 索引へロードしました ({})",
                    loaded, db_path
                );
                idx
            }
            Err(e) => {
                eprintln!(
                    "[synapse] 警告: DB を読み込めませんでした（空索引で起動を継続します）: {} — {}",
                    db_path, e
                );
                SynapseIndex::new(dim)
            }
        };

        Engine {
            embedder,
            index,
            db_path,
        }
    }

    fn handle(&mut self, req: DaemonRequest) -> DaemonResponse {
        let id = req.id;
        match req.command.as_str() {
            "health" => {
                let result = serde_json::json!({
                    "model_version": self.embedder.model_version(),
                    "dim": self.embedder.dim() as i64,
                    "total": self.index.total() as i64,
                });
                DaemonResponse::ok(id, result)
            }

            "assemble" => match serde_json::from_value::<AssembleReq>(req.raw) {
                Ok(r) => {
                    let scope: Scope = r.scope.into();
                    let qvec = self.embedder.embed(&r.query);
                    let neighbors = self.index.knn(&scope, &qvec, r.k);
                    let synapses: Vec<Value> = neighbors
                        .into_iter()
                        .map(|n| {
                            serde_json::json!({
                                "id": n.id,
                                "content": n.content,
                                "topic_id": n.topic_id,
                                "score": n.score,
                            })
                        })
                        .collect();
                    // tools は本フェーズでは常に空配列（2nd Hop の将来プレースホルダ）。
                    let result = serde_json::json!({
                        "synapses": synapses,
                        "tools": [],
                    });
                    DaemonResponse::ok(id, result)
                }
                Err(e) => DaemonResponse::err(id, format!("assemble の引数が不正: {}", e)),
            },

            "index" => match serde_json::from_value::<IndexReq>(req.raw) {
                Ok(r) => {
                    let scope: Scope = r.scope.into();
                    let vector = self.embedder.embed(&r.content);
                    let bytes = vector_to_le_bytes(&vector);
                    let embedding_b64 =
                        base64::engine::general_purpose::STANDARD.encode(&bytes);

                    self.index.insert(
                        scope,
                        Entry {
                            id: r.sid,
                            topic_id: r.topic_id,
                            content: r.content,
                            vector,
                        },
                    );

                    let result = serde_json::json!({
                        "embedding_b64": embedding_b64,
                        "model_version": self.embedder.model_version(),
                        "dim": self.embedder.dim() as i64,
                    });
                    DaemonResponse::ok(id, result)
                }
                Err(e) => DaemonResponse::err(id, format!("index の引数が不正: {}", e)),
            },

            "forget" => match serde_json::from_value::<ForgetReq>(req.raw) {
                Ok(r) => {
                    let removed = self.index.remove(r.sid);
                    DaemonResponse::ok(id, serde_json::json!({ "removed": removed }))
                }
                Err(e) => DaemonResponse::err(id, format!("forget の引数が不正: {}", e)),
            },

            "reindex" => {
                // read-only で開き直して再ロード。失敗時は現索引を保持しエラー応答（crash 厳禁）。
                match storage::load_index(&self.db_path, self.embedder.as_ref()) {
                    Ok((idx, loaded)) => {
                        self.index = idx;
                        eprintln!("[synapse] reindex: {} 件を再ロードしました", loaded);
                        DaemonResponse::ok(
                            id,
                            serde_json::json!({ "total": self.index.total() as i64 }),
                        )
                    }
                    Err(e) => {
                        eprintln!(
                            "[synapse] reindex 失敗（現索引を維持します）: {}",
                            e
                        );
                        DaemonResponse::err(id, format!("reindex に失敗: {}", e))
                    }
                }
            }

            other => DaemonResponse::err(id, format!("未知のコマンド: {}", other)),
        }
    }
}

/// 埋め込み器の生成（将来の ONNX 差し替えはここを feature ゲートで分岐させる）。
fn make_embedder(dim: usize) -> Box<dyn Embedder> {
    // #[cfg(feature = "onnx")] のときは OnnxEmbedder を返す、が将来の差し込み点。
    Box::new(HashNgramEmbedder::new(dim))
}

// ─── DAEMON モード ────────────────────────────────────────────────────────────

async fn run_daemon(db_path: String, dim: usize) -> Result<(), Box<dyn Error>> {
    let mut engine = Engine::boot(db_path, dim);

    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        // パース失敗は id:0 で固定のエラー応答（プロトコル契約）。
        let response = match DaemonRequest::parse(&line) {
            Err(e) => DaemonResponse::err(0, e),
            Ok(req) => engine.handle(req),
        };

        let json = serde_json::to_string(&response)?;
        stdout
            .write_all(format!("{}\n", json).as_bytes())
            .await?;
        stdout.flush().await?;
    }

    Ok(())
}

// ─── CLI 解析 ─────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage:");
        eprintln!("  yuuka-synapse daemon --db <path> [--dim <N>]");
        std::process::exit(1);
    }

    let command = &args[1];
    match command.as_str() {
        "daemon" => {
            let mut db_path: Option<String> = None;
            let mut dim: usize = 256;

            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--db" => {
                        if i + 1 >= args.len() {
                            eprintln!("--db には値が必要です");
                            std::process::exit(1);
                        }
                        db_path = Some(args[i + 1].clone());
                        i += 2;
                    }
                    "--dim" => {
                        if i + 1 >= args.len() {
                            eprintln!("--dim には値が必要です");
                            std::process::exit(1);
                        }
                        match args[i + 1].parse::<usize>() {
                            Ok(n) if n > 0 => dim = n,
                            _ => {
                                eprintln!("--dim は正の整数で指定してください: {}", args[i + 1]);
                                std::process::exit(1);
                            }
                        }
                        i += 2;
                    }
                    other => {
                        eprintln!("未知の引数: {}", other);
                        std::process::exit(1);
                    }
                }
            }

            // --db 省略時は env YUUKA_DB_PATH、それも無ければ ./data/yuuka.db。
            let db_path = db_path
                .or_else(|| env::var("YUUKA_DB_PATH").ok())
                .unwrap_or_else(|| "./data/yuuka.db".to_string());

            run_daemon(db_path, dim).await?;
        }
        _ => {
            eprintln!("Unknown command: {}", command);
            std::process::exit(1);
        }
    }

    Ok(())
}
