//! マイク録音 → エンコード → base64（cpal / opus / ogg / hound）。
//!
//! 仕様: client_design.md §6 / requirements.md FR-6。
//!
//! ```text
//! [押下] cpal で既定入力デバイスを開く → PCM をリングバッファへ
//! [停止] PCM を Opus(20ms) → OGG 多重化 → base64 → WS {msg, audio:{mime:"audio/ogg"}}
//!        （重い/不安定環境は WAV(PCM16) フォールバック = hound）
//! ```
//!
//! 全実装は **`audio` feature の裏**にある。feature OFF（既定）でも
//! このモジュールはコンパイルでき、呼ぶと未対応エラーを返す。

use super::RecordedAudio;

/// 録音に関するエラー。
#[derive(Debug, thiserror::Error)]
pub enum RecordError {
    /// `audio` feature が無効のままで録音が要求された。
    #[error("audio feature is not enabled in this build")]
    FeatureDisabled,
    /// 録音/エンコード処理中のエラー。
    #[error("recording error: {0}")]
    Backend(String),
}

/// 録音セッションのハンドル。
///
/// `start` で録音を開始し、`stop` で停止してエンコード済み [`RecordedAudio`] を得る。
/// 録音は別スレッド（cpal ストリームコールバック）で走り、UI はインジケータのみ。
pub struct Recorder {
    // feature 有効時のみ実体を持つ（cpal ストリーム等）。
    #[cfg(feature = "audio")]
    inner: imp::RecorderInner,
}

impl Recorder {
    /// 既定入力デバイスを開いて録音を開始する。
    pub fn start() -> Result<Self, RecordError> {
        #[cfg(feature = "audio")]
        {
            Ok(Recorder {
                inner: imp::RecorderInner::start()?,
            })
        }
        #[cfg(not(feature = "audio"))]
        {
            Err(RecordError::FeatureDisabled)
        }
    }

    /// 録音を停止し、OGG/Opus（推奨）または WAV フォールバックで
    /// エンコードして base64 添付を返す。
    pub fn stop(self) -> Result<RecordedAudio, RecordError> {
        #[cfg(feature = "audio")]
        {
            self.inner.stop()
        }
        #[cfg(not(feature = "audio"))]
        {
            Err(RecordError::FeatureDisabled)
        }
    }
}

// ===========================================================================
// feature 有効時の実装（スケルトン）
// ===========================================================================

#[cfg(feature = "audio")]
mod imp {
    use super::{RecordError, RecordedAudio};

    /// cpal ストリーム + リングバッファを保持する内部状態（Phase 4 で実装）。
    pub struct RecorderInner {
        // TODO(Phase 4): cpal::Stream, Arc<Mutex<Vec<i16>>>, サンプルレート等。
    }

    impl RecorderInner {
        pub fn start() -> Result<Self, RecordError> {
            // TODO(Phase 4):
            //   let host = cpal::default_host();
            //   let device = host.default_input_device()...;
            //   let config = device.default_input_config()...;
            //   build_input_stream(...) で PCM をリングバッファへ。
            Err(RecordError::Backend(
                "audio capture not yet implemented (Phase 4)".into(),
            ))
        }

        pub fn stop(self) -> Result<RecordedAudio, RecordError> {
            // TODO(Phase 4):
            //   PCM(i16) → opus エンコード(20ms フレーム) → ogg 多重化
            //   → base64。失敗時は hound で WAV(PCM16) フォールバック。
            //   長尺は上限（例 60s / 20MB）で打ち切り。
            let _ = RecordedAudio {
                mime: "audio/ogg".into(),
                data_base64: String::new(),
            };
            Err(RecordError::Backend(
                "audio encode not yet implemented (Phase 4)".into(),
            ))
        }
    }
}
