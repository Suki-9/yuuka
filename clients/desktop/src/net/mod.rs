//! ネットワーク層: WS クライアント・REST・OAuth デバイスフロー。
//!
//! UI スレッド（egui）と Net スレッド（tokio runtime）は分離され、
//! [`UiEvent`] / [`NetEvent`] を `tokio::sync::mpsc` で双方向に流す
//! （client_design.md §3 / architecture.md §8）。
//!
//! - `UiEvent`: UI → Net（送信要求・Bot 切替・リセット・録音完了 …）
//! - `NetEvent`: Net → UI（`ready`/`status`/`done`/`push`/`error` や接続状態変化）

pub mod auth;
pub mod rest;
pub mod ws;

use crate::model::{ClientFrame, ServerFrame};

/// UI → Net の要求イベント。
#[derive(Debug, Clone)]
pub enum UiEvent {
    /// WS でフレームを送る（`msg`/`reset`/`ping`）。
    Send(ClientFrame),
    /// 別 Bot へ切替（現 WS を閉じ `?botId=` を変えて張り直す。client_design.md §9）。
    SwitchBot { bot_id: String },
    /// アプリ終了に伴う Net タスク停止要求。
    Shutdown,
}

/// Net → UI の通知イベント。
#[derive(Debug, Clone)]
pub enum NetEvent {
    /// 接続状態の変化（ヘッダのオンライン/再接続中表示に使う）。
    Connection(ConnectionState),
    /// サーバから届いたプロトコルフレーム（そのまま UI へ）。
    Frame(ServerFrame),
    /// 致命的でないネットワークエラーの通知（再接続は内部で継続）。
    NetError(String),
}

/// WS 接続状態（client_design.md §5「接続状態」表示）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    /// 未接続（起動直後やログイン前）。
    Disconnected,
    /// 接続試行中。
    Connecting,
    /// 接続済み（`ready` 受領後）。`bot_id` は束縛中の Bot。
    Connected { bot_id: String },
    /// 切断され再接続待ち（指数バックオフ中）。`next_retry_secs` は次回待機秒。
    Reconnecting { next_retry_secs: u64 },
}
