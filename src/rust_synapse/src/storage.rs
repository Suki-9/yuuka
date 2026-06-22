// ─────────────────────────────────────────────────────────────────────────────
//  SQLite からの読み込み（READ-ONLY）
// ─────────────────────────────────────────────────────────────────────────────
//
//  architecture_renewal_v3.md §7 の方針「Rust は SQLite を read-only で読む」を遵守。
//  書き手は Node のみ。本プロセスは絶対に書かない（READ_ONLY フラグで強制）。
//
//  【堅牢性の絶対要件】
//  RAM 索引は再構築可能なキャッシュであり、欠落は性能劣化に過ぎず**データ損失では
//  ない**。よって DB が開けない・読めない等いかなる理由でも panic / exit せず、
//  日本語警告を stderr へ出して**空索引で稼働を継続**する。呼び出し側はこの方針を
//  守ること。
// ─────────────────────────────────────────────────────────────────────────────

use rusqlite::{Connection, OpenFlags};

use crate::embedder::Embedder;
use crate::index::{le_bytes_to_vector, Entry, Scope, SynapseIndex};

/// SQLite を read-only で開き、embedding 非 NULL の全行を RAM 索引へロードする。
///
/// 失敗時は Err を返す（呼び出し側は空索引で続行する）。成功時はロード件数を返す。
pub fn load_index(
    db_path: &str,
    embedder: &dyn Embedder,
) -> Result<(SynapseIndex, usize), String> {
    let dim = embedder.dim();
    let mut index = SynapseIndex::new(dim);

    // read-only かつ URI 許可で開く（書き込みは構造的に不可能）。
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("DBを開けませんでした: {}", e))?;

    // ロック競合に備えて busy_timeout を設定（書き手 Node と共存するため）。
    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(|e| format!("busy_timeout 設定に失敗: {}", e))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, user_id, bot_id, guild_id, content, topic_id, embedding \
             FROM synapses WHERE embedding IS NOT NULL",
        )
        .map_err(|e| format!("クエリ準備に失敗: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            let id: i64 = row.get(0)?;
            let user_id: String = row.get(1)?;
            let bot_id: String = row.get(2)?;
            let guild_id: Option<String> = row.get(3)?;
            let content: String = row.get(4)?;
            let topic_id: Option<String> = row.get(5)?;
            let embedding: Vec<u8> = row.get(6)?;
            Ok((id, user_id, bot_id, guild_id, content, topic_id, embedding))
        })
        .map_err(|e| format!("行の読み出しに失敗: {}", e))?;

    let mut loaded = 0usize;
    let expected_bytes = dim * 4;

    for row in rows {
        let (id, user_id, bot_id, guild_id, content, topic_id, embedding) = match row {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[synapse] 行の取得をスキップ: {}", e);
                continue;
            }
        };

        let vector = match le_bytes_to_vector(&embedding) {
            Some(v) if v.len() * 4 == expected_bytes => v,
            Some(v) => {
                eprintln!(
                    "[synapse] 次元不一致のためスキップ: id={} (期待 {} 要素, 実 {} 要素)",
                    id,
                    dim,
                    v.len()
                );
                continue;
            }
            None => {
                eprintln!(
                    "[synapse] embedding が f32 境界(4の倍数)でないためスキップ: id={} ({} バイト)",
                    id,
                    embedding.len()
                );
                continue;
            }
        };

        let scope = Scope {
            user_id,
            bot_id,
            guild_id,
        };
        index.insert(
            scope,
            Entry {
                id,
                topic_id,
                content,
                vector,
            },
        );
        loaded += 1;
    }

    Ok((index, loaded))
}
