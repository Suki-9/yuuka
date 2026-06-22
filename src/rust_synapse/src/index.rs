// ─────────────────────────────────────────────────────────────────────────────
//  RAM ベクトル索引（スコープ別バケット・総当たりコサイン KNN）
// ─────────────────────────────────────────────────────────────────────────────
//
//  この索引は意図的に **V8 ヒープの外**（Rust プロセスの RAM）に置く。
//  記憶の重い処理（埋め込み保持・近傍探索）を Node から切り離すのが本プロセスの
//  存在理由（architecture_renewal_v3.md §5.4）。
//
//  現フェーズは「スコープ単位・総当たりコサイン KNN」。1スコープあたり数千件しか
//  ないため総当たりでもサブミリ秒で完了する（設計書が総当たりを是としている）。
//  将来 USearch 等の近似最近傍へ差し替える際も、本構造体の公開 API
//  （insert / remove / knn / load 系）を保てば呼び出し側は不変。
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;

use crate::embedder::cosine;

/// スコープ（user_id / bot_id / guild_id の複合）。
/// guild_id 不在は None として扱い、None 同士・値同士が一致したときのみ同一スコープ。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Scope {
    pub user_id: String,
    pub bot_id: String,
    pub guild_id: Option<String>,
}

/// RAM 上の1シナプス・エントリ。
#[derive(Clone, Debug)]
pub struct Entry {
    pub id: i64,
    pub topic_id: Option<String>,
    pub content: String,
    pub vector: Vec<f32>,
}

/// 1スコープあたりの保持上限。超過時は最小 id を退避（FIFO 近似）し、
/// メモリが無限に増えないよう上限を固定する（§5.4）。
pub const MAX_PER_SCOPE: usize = 5000;

/// KNN の結果1件。
pub struct Neighbor {
    pub id: i64,
    pub content: String,
    pub topic_id: Option<String>,
    pub score: f32,
}

/// スコープ別バケットを束ねる RAM 索引。
pub struct SynapseIndex {
    /// スコープ → エントリ群。
    buckets: HashMap<Scope, Vec<Entry>>,
}

impl SynapseIndex {
    /// 期待次元は現状ベクトル長検証に使わず（呼び出し側が embedder.dim で検証）、
    /// 将来の近似最近傍実装への差し替え互換のためシグネチャだけ受ける。
    pub fn new(_dim: usize) -> Self {
        SynapseIndex {
            buckets: HashMap::new(),
        }
    }

    /// 全スコープ合計の保持件数。
    pub fn total(&self) -> usize {
        self.buckets.values().map(|v| v.len()).sum()
    }

    /// エントリを挿入／置換（id をキーに同一スコープ内で重複排除）。
    /// スコープ上限を超える場合は最小 id を退避してから挿入する。
    pub fn insert(&mut self, scope: Scope, entry: Entry) {
        // 念のため：他スコープに同 id が残っていると forget(id) の意味が曖昧になるため、
        // 異なるスコープに同一 id があれば取り除いてから入れ直す。
        self.remove_from_other_scopes(&scope, entry.id);

        let bucket = self.buckets.entry(scope).or_default();

        // 既存（同 id）を置換。
        if let Some(slot) = bucket.iter_mut().find(|e| e.id == entry.id) {
            *slot = entry;
            return;
        }

        // 上限超過なら最小 id を退避（FIFO 近似）。
        if bucket.len() >= MAX_PER_SCOPE {
            if let Some((min_pos, _)) = bucket
                .iter()
                .enumerate()
                .min_by_key(|(_, e)| e.id)
            {
                let evicted = bucket.swap_remove(min_pos);
                // 退避ログは過剰に出さない（上限到達時のみ）。
                eprintln!(
                    "[synapse] スコープ上限({})到達: id={} を退避しました",
                    MAX_PER_SCOPE, evicted.id
                );
            }
        }

        bucket.push(entry);
    }

    /// 指定スコープ以外のバケットから同一 id を取り除く（内部ヘルパ）。
    fn remove_from_other_scopes(&mut self, keep: &Scope, id: i64) {
        for (scope, bucket) in self.buckets.iter_mut() {
            if scope == keep {
                continue;
            }
            bucket.retain(|e| e.id != id);
        }
    }

    /// id でエントリを除去（どのスコープにあっても）。除去できたら true。
    pub fn remove(&mut self, id: i64) -> bool {
        let mut removed = false;
        for bucket in self.buckets.values_mut() {
            let before = bucket.len();
            bucket.retain(|e| e.id != id);
            if bucket.len() != before {
                removed = true;
            }
        }
        // 空になったバケットは掃除する。
        self.buckets.retain(|_, v| !v.is_empty());
        removed
    }

    /// 指定スコープに対する総当たりコサイン KNN（スコア降順、最大 k 件）。
    pub fn knn(&self, scope: &Scope, query: &[f32], k: usize) -> Vec<Neighbor> {
        let bucket = match self.buckets.get(scope) {
            Some(b) => b,
            None => return Vec::new(),
        };

        let mut scored: Vec<(f32, &Entry)> = bucket
            .iter()
            .map(|e| (cosine(query, &e.vector), e))
            .collect();

        // スコア降順（NaN は最後尾相当に倒す）。
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal)
        });

        scored
            .into_iter()
            .take(k)
            .map(|(score, e)| Neighbor {
                id: e.id,
                content: e.content.clone(),
                topic_id: e.topic_id.clone(),
                score,
            })
            .collect()
    }
}

/// f32 ベクトルを「リトルエンディアン・連続バイト列」へ。
/// これは Node 側 SQLite BLOB との **ハード契約**（dim*4 バイト）。
pub fn vector_to_le_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for &x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// リトルエンディアン f32 バイト列を Vec<f32> へ復号。
/// 長さが4の倍数でなければ None（呼び出し側でスキップ＋警告）。
pub fn le_bytes_to_vector(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr = [chunk[0], chunk[1], chunk[2], chunk[3]];
        out.push(f32::from_le_bytes(arr));
    }
    Some(out)
}
