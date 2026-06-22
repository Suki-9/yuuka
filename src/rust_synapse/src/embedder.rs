// ─────────────────────────────────────────────────────────────────────────────
//  埋め込み生成モジュール（Embedder）
// ─────────────────────────────────────────────────────────────────────────────
//
//  【現状＝レキシカル・フォールバック】
//  本モジュールの既定実装 `HashNgramEmbedder` は、外部依存ゼロ・決定論的な
//  「ハッシュ文字 n-gram」埋め込みである。意味的な近さではなく字面（語彙）の
//  重なりを捉えるに過ぎないため、あくまで本物のニューラル埋め込みが入るまでの
//  繋ぎ（フォールバック）と位置づける。CJK 混在・短文でも破綻しないよう
//  unigram も併用する。
//
//  【将来＝ONNX 実埋め込みモデルの差し込みポイント】
//  architecture_renewal_v3.md §記憶コア／表(埋め込み)に従い、ここが
//  `bge-micro` 級（INT8 量子化）を `ort`（ONNX Runtime）もしくは `candle`
//  で駆動する実埋め込みへ差し替える「唯一の場所」である。
//  差し替え手順（想定）:
//    1. Cargo.toml の `[features] onnx = []` を有効化し、
//       `ort`（または `candle`）と tokenizer 依存をこのフィーチャ配下に追加する。
//    2. 本ファイルに `#[cfg(feature = "onnx")] pub struct OnnxEmbedder { ... }`
//       を実装し、同じ `Embedder` トレイトを実装する。
//    3. `MODEL_VERSION` を実モデルの識別子（例: "bge-micro-int8-v1"）へ更新する。
//       ※ MODEL_VERSION が変わると埋め込みの互換性が切れる。Node 側で
//         再 index（reindex）して BLOB を作り直す前提（バイト契約は不変）。
//    4. `main.rs` の `make_embedder()` を feature ゲートで分岐させる。
//  トレイト境界（`embed(&str) -> Vec<f32>` と `dim()` / `model_version()`）と
//  「f32・リトルエンディアン・連続」のバイト契約は不変に保つこと。これにより
//  Node 側の SQLite BLOB 永続化フォーマットを壊さずに中身だけ差し替えられる。
// ─────────────────────────────────────────────────────────────────────────────

/// 埋め込み器の抽象。実装を差し替えても呼び出し側（main.rs）は不変。
pub trait Embedder {
    /// 入力文字列を `dim()` 次元の L2 正規化済みベクトルへ。
    fn embed(&self, text: &str) -> Vec<f32>;
    /// 出力次元数。
    fn dim(&self) -> usize;
    /// モデル識別子（埋め込みの互換性キー）。
    fn model_version(&self) -> &'static str;
}

/// 既定（レキシカル・フォールバック）埋め込みのモデル識別子。
pub const MODEL_VERSION: &str = "hash-ngram-v1";

/// ハッシュ文字 n-gram 埋め込み器（依存ゼロ・決定論的）。
pub struct HashNgramEmbedder {
    dim: usize,
}

impl HashNgramEmbedder {
    pub fn new(dim: usize) -> Self {
        // 次元0は無意味なので最低1に丸める（健全性のため）。
        let dim = if dim == 0 { 1 } else { dim };
        HashNgramEmbedder { dim }
    }
}

/// FNV-1a（64bit）ハッシュ。安定・高速・依存ゼロ。
/// 同一文字列は常に同一ハッシュ → 埋め込みの決定論性を担保する。
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x00000100000001b3;
    let mut hash = FNV_OFFSET;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

impl Embedder for HashNgramEmbedder {
    fn embed(&self, text: &str) -> Vec<f32> {
        let mut vec = vec![0.0f32; self.dim];

        // 小文字化して Unicode スカラ単位で扱う（CJK もそのまま1文字として）。
        let lowered = text.to_lowercase();
        let chars: Vec<char> = lowered.chars().collect();

        // 1つの n-gram をベクトルへ加算するヘルパ。
        // ハッシュの最下位ビットを符号として使い、+1.0 / -1.0 を蓄積する
        // （キャンセル可能にして衝突由来の偏りを緩和する）。
        let accumulate = |gram: &str, vec: &mut Vec<f32>| {
            let h = fnv1a_64(gram.as_bytes());
            let idx = (h % self.dim as u64) as usize;
            let sign = if (h >> 1) & 1 == 0 { 1.0 } else { -1.0 };
            vec[idx] += sign;
        };

        // unigram（短文・CJK 混在を頑健に扱うため）。
        let mut buf = String::new();
        for &c in &chars {
            buf.clear();
            buf.push(c);
            accumulate(&buf, &mut vec);
        }

        // 文字 3-gram。
        const N: usize = 3;
        if chars.len() >= N {
            for window in chars.windows(N) {
                buf.clear();
                for &c in window {
                    buf.push(c);
                }
                accumulate(&buf, &mut vec);
            }
        }

        // L2 正規化（ゼロベクトルはそのまま＝NaN を避ける）。
        let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in vec.iter_mut() {
                *x /= norm;
            }
        }

        vec
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn model_version(&self) -> &'static str {
        MODEL_VERSION
    }
}

/// コサイン類似度。両ベクトルとも L2 正規化済みなら内積に一致するが、
/// 念のため防御的に norm で割る（保存側・クエリ側の双方で一貫した結果を保証）。
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na <= 0.0 || nb <= 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}
