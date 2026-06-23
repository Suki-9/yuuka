//! WebSocket チャットプロトコルの serde 型定義。
//!
//! **このモジュールはバックエンドとの「契約」であり、唯一の正は
//! [`docs/design/desktop_client/backend_api.md`] §3 のワイヤ形である。**
//! 余計な依存を持たず自己完結させること。フレームは全て JSON テキスト
//! フレームで、`{"type":"..."}` タグ付き discriminated union。
//!
//! - クライアント → サーバ: [`ClientFrame`]（`msg` / `reset` / `ping`）
//! - サーバ → クライアント: [`ServerFrame`]
//!   （`ready` / `status` / `interim` / `token` / `done` / `push` / `error`）
//!
//! `botId` は WS 接続時に `?botId=` で束縛されるため、各メッセージには含めない
//! （backend_api.md §3.2）。

use serde::{Deserialize, Serialize};

// ===========================================================================
// 添付（画像 / 音声）— base64 を JSON に内包（backend_api.md §3.2 / §3.3）
// ===========================================================================

/// 画像/音声の添付ペイロード。`data` は base64 エンコード済み文字列。
///
/// 送信（`msg`）の image/audio と、受信（`done`/`push`）の `files[]` 形が
/// それぞれ別物（後者は `name` を持つ）なので、用途別に型を分けている。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attachment {
    /// MIME タイプ。例: 画像 `"image/png"`、音声 `"audio/ogg"`。
    pub mime: String,
    /// base64 エンコードされたバイト列。
    pub data: String,
}

// ===========================================================================
// クライアント → サーバ（backend_api.md §3.2）
// ===========================================================================

/// クライアントが WS で送るフレーム。
///
/// `#[serde(tag = "type", rename_all = "lowercase")]` でドキュメントの
/// `{"type":"msg"|"reset"|"ping"}` 形に一致させる。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientFrame {
    /// 発話。テキスト＋任意の画像/音声＋任意の返信チェーン ID。
    Msg {
        /// 本文（空文字許容。画像/音声のみの発話もありうる）。
        text: String,
        /// 任意の画像添付（`{mime, data}`）。
        #[serde(skip_serializing_if = "Option::is_none", default)]
        image: Option<Attachment>,
        /// 任意の音声添付（`{mime, data}`、推奨 `audio/ogg`）。
        #[serde(skip_serializing_if = "Option::is_none", default)]
        audio: Option<Attachment>,
        /// 任意: 返信チェーンの対象メッセージ ID。
        #[serde(rename = "replyToId", skip_serializing_if = "Option::is_none", default)]
        reply_to_id: Option<String>,
    },

    /// 会話リセット（接続束縛の Bot に対するコンテキストクリア）。
    Reset,

    /// keepalive（任意。WS ping/pong を使うなら不要だがプロトコルには存在）。
    Ping,
}

impl ClientFrame {
    /// テキストのみの発話を作るショートカット。
    pub fn text(text: impl Into<String>) -> Self {
        ClientFrame::Msg {
            text: text.into(),
            image: None,
            audio: None,
            reply_to_id: None,
        }
    }
}

// ===========================================================================
// リッチコンテンツ（embeds / files）— backend_api.md §3.3 / architecture.md §7
// ===========================================================================

/// Embed のフィールド（`{name, value, inline?}`）。
///
/// discord.js の `EmbedBuilder#fields` を中立 JSON に直列化したもの。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct EmbedField {
    pub name: String,
    pub value: String,
    /// 横並び表示の可否。Discord 互換のため任意。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub inline: Option<bool>,
}

/// Embed 内の画像参照。`name` は同梱 `files[]` の同名添付へ解決してインライン表示する
/// （architecture.md §7: `attachment://chart.png` → base64 添付）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbedImage {
    pub name: String,
}

/// Embed カード（タイトル / 本文 / 色帯 / フィールド / 画像）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Embed {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    /// 色帯（10 進 RGB 整数。例 `3447003`）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub color: Option<u32>,
    /// フィールド配列。省略時は空。
    #[serde(default)]
    pub fields: Vec<EmbedField>,
    /// インライン画像参照。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub image: Option<EmbedImage>,
}

/// 受信ファイル（チャート PNG 等）。`data` は base64。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FilePayload {
    pub name: String,
    pub mime: String,
    /// base64 エンコードされたバイト列。
    pub data: String,
}

// ===========================================================================
// `ready` フレームの構造体（backend_api.md §3.1 / §3.3）
// ===========================================================================

/// 認証済みユーザー情報（`ready.user`）。
///
/// バックエンドの `SessionUser` 相当。フィールド名はサーバ実装に合わせる
/// （Discord ID は `discordId`、ロールは任意）。前方互換のため未知フィールドは無視。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct UserInfo {
    #[serde(rename = "discordId")]
    pub discord_id: String,
    #[serde(default)]
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub role: Option<String>,
}

/// Bot のメタ情報（`ready.bot` / `ready.bots[]`）。
///
/// オーブのアイコン（`discord_avatar_url`）と、ホットキー登録の可否
/// （`primary`）に使う。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct BotInfo {
    pub id: String,
    pub name: String,
    /// オーブに描く Discord アバター URL。未設定の Bot もありうるので任意。
    #[serde(
        rename = "discord_avatar_url",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub discord_avatar_url: Option<String>,
    /// プライマリ Bot か（グローバルホットキー登録の可否判定）。
    #[serde(default)]
    pub primary: bool,
}

// ===========================================================================
// サーバ → クライアント（backend_api.md §3.3）
// ===========================================================================

/// サーバ進捗ステータス（`status.state`）。
///
/// `onStatusChange("thinking"|"writing")` を直列化したもの（`idle` は送らない）。
/// 前方互換のため未知の値も保持できるよう `Other` を用意する。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusState {
    Thinking,
    Writing,
    /// 未知のステータス（プロトコル拡張に前方互換で耐える）。
    #[serde(other)]
    Other,
}

/// サーバが WS で送るフレーム。
///
/// `#[serde(tag = "type", rename_all = "lowercase")]` でドキュメントの
/// `{"type":"ready"|"status"|...}` 形に一致させる。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerFrame {
    /// 接続確立直後に一度だけ届く。オーブ画像・切替セレクタ・送信上限を確定する。
    Ready {
        user: UserInfo,
        /// この接続が束縛された Bot。
        bot: BotInfo,
        /// 利用可能な Bot 一覧（切替 UI / 別オーバーレイ導線）。
        #[serde(default)]
        bots: Vec<BotInfo>,
        /// 1 メッセージ添付上限（MB）。送信前にローカルで弾く。
        #[serde(rename = "maxUploadMb")]
        max_upload_mb: u32,
    },

    /// 進捗ステータス（「考え中…」「入力中…」）。
    Status { state: StatusState },

    /// 重い処理の一時応答（通常の assistant 気泡として差し込む）。
    Interim { text: String },

    /// 将来: トークン逐次（v1 では送られない。architecture.md §6）。
    Token { delta: String },

    /// ターン最終応答（テキスト＋リッチコンテンツ）。
    Done {
        #[serde(rename = "messageId")]
        message_id: String,
        text: String,
        #[serde(default)]
        embeds: Vec<Embed>,
        #[serde(default)]
        files: Vec<FilePayload>,
        /// `true` の場合、後続で `push` フレームが届く（重い処理）。
        #[serde(default)]
        deferred: bool,
    },

    /// 重い処理（`done` で `deferred:true` を返した後）の最終結果。
    Push {
        text: String,
        #[serde(default)]
        embeds: Vec<Embed>,
        #[serde(default)]
        files: Vec<FilePayload>,
    },

    /// エラー（コード＋人間向けメッセージ）。
    Error { code: ErrorCode, message: String },
}

/// エラーコード（backend_api.md §7）。未知コードにも前方互換で耐える。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// トークン無効/失効 → 保存トークン破棄して再ログイン。
    Unauthorized,
    /// ユーザーの Gemini キー未設定 → Web 設定へ誘導。
    NoGeminiKey,
    /// レート超過 → バックオフして再送。
    RateLimited,
    /// ペイロード超過 → 画像縮小/音声短縮を促す。
    TooLarge,
    /// サーバ内部エラー → 再試行を促す。
    Internal,
    /// 未知のコード（プロトコル拡張に前方互換で耐える）。
    #[serde(other)]
    Unknown,
}

// ===========================================================================
// テスト: serde 往復（model.rs は契約なので最重要。設計 §12）
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msg_roundtrip_minimal() {
        let frame = ClientFrame::text("こんにちは");
        let json = serde_json::to_string(&frame).unwrap();
        // image/audio/replyToId は None なので出力されないこと。
        assert_eq!(json, r#"{"type":"msg","text":"こんにちは"}"#);
        let back: ClientFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(frame, back);
    }

    #[test]
    fn client_msg_with_attachments() {
        let frame = ClientFrame::Msg {
            text: "これ何のエラー？".into(),
            image: Some(Attachment {
                mime: "image/png".into(),
                data: "QUJD".into(),
            }),
            audio: None,
            reply_to_id: Some("123".into()),
        };
        let json = serde_json::to_string(&frame).unwrap();
        let back: ClientFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(frame, back);
        // ドキュメントの replyToId キー名であること。
        assert!(json.contains("\"replyToId\":\"123\""));
        assert!(json.contains("\"image\":{\"mime\":\"image/png\",\"data\":\"QUJD\"}"));
    }

    #[test]
    fn client_reset_and_ping_shape() {
        assert_eq!(
            serde_json::to_string(&ClientFrame::Reset).unwrap(),
            r#"{"type":"reset"}"#
        );
        assert_eq!(
            serde_json::to_string(&ClientFrame::Ping).unwrap(),
            r#"{"type":"ping"}"#
        );
    }

    #[test]
    fn server_ready_parse() {
        let json = r#"{
            "type":"ready",
            "user":{"discordId":"u1","username":"komorida","role":"admin"},
            "bot":{"id":"b1","name":"ユウカ","discord_avatar_url":"https://x/a.png","primary":true},
            "bots":[{"id":"b1","name":"ユウカ","discord_avatar_url":"https://x/a.png","primary":true},
                    {"id":"b2","name":"カヨコ","primary":false}],
            "maxUploadMb":20
        }"#;
        let frame: ServerFrame = serde_json::from_str(json).unwrap();
        match frame {
            ServerFrame::Ready {
                bot,
                bots,
                max_upload_mb,
                user,
            } => {
                assert_eq!(user.discord_id, "u1");
                assert_eq!(bot.id, "b1");
                assert!(bot.primary);
                assert_eq!(bots.len(), 2);
                // discord_avatar_url 未設定の Bot も許容される。
                assert!(bots[1].discord_avatar_url.is_none());
                assert_eq!(max_upload_mb, 20);
            }
            _ => panic!("expected ready"),
        }
    }

    #[test]
    fn server_status_parse() {
        let f: ServerFrame =
            serde_json::from_str(r#"{"type":"status","state":"thinking"}"#).unwrap();
        assert_eq!(
            f,
            ServerFrame::Status {
                state: StatusState::Thinking
            }
        );
        // 未知の state も Other に落ちる（前方互換）。
        let f2: ServerFrame =
            serde_json::from_str(r#"{"type":"status","state":"reflecting"}"#).unwrap();
        assert_eq!(
            f2,
            ServerFrame::Status {
                state: StatusState::Other
            }
        );
    }

    #[test]
    fn server_done_with_rich() {
        let json = r#"{
            "type":"done",
            "messageId":"m1",
            "text":"リマインドを登録しました。",
            "embeds":[{"title":"予定","description":"歯医者","color":3447003,
                       "fields":[{"name":"日時","value":"明日10時","inline":true}],
                       "image":{"name":"chart.png"}}],
            "files":[{"name":"chart.png","mime":"image/png","data":"QUJD"}],
            "deferred":false
        }"#;
        let frame: ServerFrame = serde_json::from_str(json).unwrap();
        match frame {
            ServerFrame::Done {
                message_id,
                embeds,
                files,
                deferred,
                ..
            } => {
                assert_eq!(message_id, "m1");
                assert_eq!(embeds.len(), 1);
                assert_eq!(embeds[0].color, Some(3447003));
                assert_eq!(embeds[0].fields[0].inline, Some(true));
                assert_eq!(embeds[0].image.as_ref().unwrap().name, "chart.png");
                assert_eq!(files[0].mime, "image/png");
                assert!(!deferred);
            }
            _ => panic!("expected done"),
        }
    }

    #[test]
    fn server_done_minimal_text_only() {
        // richReplyEnabled=false のユーザーは embeds/files が無い（テキストのみ）。
        let json = r#"{"type":"done","messageId":"m2","text":"はい。"}"#;
        let frame: ServerFrame = serde_json::from_str(json).unwrap();
        match frame {
            ServerFrame::Done {
                embeds,
                files,
                deferred,
                ..
            } => {
                assert!(embeds.is_empty());
                assert!(files.is_empty());
                assert!(!deferred);
            }
            _ => panic!("expected done"),
        }
    }

    #[test]
    fn server_push_and_interim() {
        let i: ServerFrame =
            serde_json::from_str(r#"{"type":"interim","text":"やっておきます。"}"#).unwrap();
        assert_eq!(
            i,
            ServerFrame::Interim {
                text: "やっておきます。".into()
            }
        );

        let p: ServerFrame = serde_json::from_str(
            r#"{"type":"push","text":"完了しました。","embeds":[],"files":[]}"#,
        )
        .unwrap();
        match p {
            ServerFrame::Push { text, .. } => assert_eq!(text, "完了しました。"),
            _ => panic!("expected push"),
        }
    }

    #[test]
    fn server_error_codes() {
        let cases = [
            (
                r#"{"type":"error","code":"unauthorized","message":"x"}"#,
                ErrorCode::Unauthorized,
            ),
            (
                r#"{"type":"error","code":"no_gemini_key","message":"x"}"#,
                ErrorCode::NoGeminiKey,
            ),
            (
                r#"{"type":"error","code":"rate_limited","message":"x"}"#,
                ErrorCode::RateLimited,
            ),
            (
                r#"{"type":"error","code":"too_large","message":"x"}"#,
                ErrorCode::TooLarge,
            ),
            (
                r#"{"type":"error","code":"internal","message":"x"}"#,
                ErrorCode::Internal,
            ),
            // 未知コードは Unknown へ（前方互換）。
            (
                r#"{"type":"error","code":"teapot","message":"x"}"#,
                ErrorCode::Unknown,
            ),
        ];
        for (json, expected) in cases {
            match serde_json::from_str::<ServerFrame>(json).unwrap() {
                ServerFrame::Error { code, .. } => assert_eq!(code, expected),
                _ => panic!("expected error"),
            }
        }
    }
}
