//! WebSocket クライアント（tokio-tungstenite）。
//!
//! 仕様: client_design.md §9 / backend_api.md §3。
//!
//! - `wss://{host}/ws/chat?botId={id}` に `Authorization: Bearer` 付きで接続。
//! - 受信タスク: JSON を [`ServerFrame`] にデコードし [`NetEvent::Frame`] で UI へ。
//! - 送信タスク: UI からの [`UiEvent::Send`] を WS テキストフレームへ。
//! - 指数バックオフ再接続（1s→2s→…→上限 30s）。再接続後 `ready` で復帰。
//! - keepalive: 一定間隔で WS Ping。
//! - **Bot 切替 = 再接続**（[`UiEvent::SwitchBot`] で現接続を閉じ新 botId で張り直す）。
//!
//! このモジュールは「タスク構造」を提供する。UI 消費側がスタブでも、
//! [`run_ws_loop`] は単体で回せる（mpsc を渡すだけ）。

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::Message;

use crate::config::ws_url;
use crate::model::ClientFrame;

use super::{ConnectionState, NetEvent, UiEvent};

/// keepalive Ping 間隔（backend_api.md §3.5: 例 30s）。
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// 再接続バックオフの初期値・上限（client_design.md §9: 1s→…→30s）。
const BACKOFF_INITIAL: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// WS ループの実行に必要なハンドル一式。
pub struct WsHandle {
    /// 接続先の Bearer トークン。
    pub token: String,
    /// 初期接続する botId（接続束縛）。
    pub bot_id: String,
    /// UI → Net（送信要求・Bot 切替・停止）。
    pub ui_rx: mpsc::Receiver<UiEvent>,
    /// Net → UI（フレーム・接続状態・エラー）。
    pub net_tx: mpsc::Sender<NetEvent>,
}

/// WS のメインループ。切断されたらバックオフして再接続し続ける。
///
/// [`UiEvent::Shutdown`] を受けるか `ui_rx` が閉じたら終了する。
/// [`UiEvent::SwitchBot`] は内部状態の botId を差し替えて再接続させる。
pub async fn run_ws_loop(mut handle: WsHandle) {
    let mut backoff = BACKOFF_INITIAL;
    // 切断中に積まれた送信を退避するキュー（NFR-6: 再接続後に再送）。
    let mut outbox: Vec<ClientFrame> = Vec::new();

    loop {
        let _ = handle
            .net_tx
            .send(NetEvent::Connection(ConnectionState::Connecting))
            .await;

        match connect(&handle.token, &handle.bot_id).await {
            Ok(stream) => {
                backoff = BACKOFF_INITIAL; // 接続成功でバックオフをリセット。
                let _ = handle
                    .net_tx
                    .send(NetEvent::Connection(ConnectionState::Connected {
                        bot_id: handle.bot_id.clone(),
                    }))
                    .await;

                // 退避していた送信を先頭に注入して、1 接続分のセッションを回す。
                let outcome = run_session(&mut handle, stream, &mut outbox).await;
                match outcome {
                    SessionOutcome::Shutdown => return,
                    SessionOutcome::SwitchBot(new_id) => {
                        // Bot 切替: 即時に新 botId で張り直す（バックオフ無し）。
                        handle.bot_id = new_id;
                        outbox.clear(); // 別 Bot の文脈なので退避は破棄。
                        continue;
                    }
                    SessionOutcome::Disconnected => {
                        // 通常切断 → バックオフへ。
                    }
                }
            }
            Err(e) => {
                let _ = handle
                    .net_tx
                    .send(NetEvent::NetError(format!("connect failed: {e}")))
                    .await;
            }
        }

        // 再接続待ち（指数バックオフ）。待機中に Shutdown / SwitchBot を受けたら反応する。
        let _ = handle
            .net_tx
            .send(NetEvent::Connection(ConnectionState::Reconnecting {
                next_retry_secs: backoff.as_secs(),
            }))
            .await;

        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            msg = handle.ui_rx.recv() => match msg {
                Some(UiEvent::Shutdown) | None => return,
                Some(UiEvent::SwitchBot { bot_id }) => {
                    handle.bot_id = bot_id;
                    outbox.clear();
                    backoff = BACKOFF_INITIAL;
                    continue;
                }
                // 切断中の送信は退避キューへ（再接続後に再送）。
                Some(UiEvent::Send(frame)) => outbox.push(frame),
            }
        }

        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// 1 接続分のセッション内ループの結果。
enum SessionOutcome {
    /// アプリ終了。
    Shutdown,
    /// Bot 切替要求（新 botId）。
    SwitchBot(String),
    /// 接続が切れた（再接続へ）。
    Disconnected,
}

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// `wss://.../ws/chat?botId={id}` へ Bearer 付きで接続する。
async fn connect(
    token: &str,
    bot_id: &str,
) -> Result<WsStream, tokio_tungstenite::tungstenite::Error> {
    let url = ws_url(bot_id);
    // ネイティブクライアントは upgrade リクエストに任意ヘッダを付けられる
    // （backend_api.md §3.1: Authorization: Bearer）。
    let mut request = url.into_client_request()?;
    request.headers_mut().insert(
        AUTHORIZATION,
        format!("Bearer {token}")
            .parse()
            .expect("bearer header value is valid ascii"),
    );
    let (stream, _resp) = tokio_tungstenite::connect_async(request).await?;
    Ok(stream)
}

/// 接続確立後の送受信ループ。送信（UI/keepalive）と受信を `select!` で多重化する。
async fn run_session(
    handle: &mut WsHandle,
    stream: WsStream,
    outbox: &mut Vec<ClientFrame>,
) -> SessionOutcome {
    let (mut sink, mut source) = stream.split();
    let mut ping_timer = tokio::time::interval(PING_INTERVAL);
    ping_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // 再接続直後に退避分を送り直す（NFR-6）。
    for frame in outbox.drain(..) {
        if send_frame(&mut sink, &frame, &handle.net_tx).await.is_err() {
            // 送れなければ退避へ戻して切断扱い。
            outbox.push(frame);
            return SessionOutcome::Disconnected;
        }
    }

    loop {
        tokio::select! {
            // --- UI → WS（送信要求 / 切替 / 停止）---
            ui = handle.ui_rx.recv() => match ui {
                None | Some(UiEvent::Shutdown) => {
                    let _ = sink.close().await;
                    return SessionOutcome::Shutdown;
                }
                Some(UiEvent::SwitchBot { bot_id }) => {
                    let _ = sink.close().await;
                    return SessionOutcome::SwitchBot(bot_id);
                }
                Some(UiEvent::Send(frame)) => {
                    if send_frame(&mut sink, &frame, &handle.net_tx).await.is_err() {
                        // 送信失敗 → 退避して切断扱い。
                        outbox.push(frame);
                        return SessionOutcome::Disconnected;
                    }
                }
            },

            // --- keepalive Ping ---
            _ = ping_timer.tick() => {
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    return SessionOutcome::Disconnected;
                }
            }

            // --- WS → UI（受信）---
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<crate::model::ServerFrame>(&text) {
                        Ok(frame) => {
                            let _ = handle.net_tx.send(NetEvent::Frame(frame)).await;
                        }
                        Err(e) => {
                            let _ = handle.net_tx
                                .send(NetEvent::NetError(format!("decode error: {e}")))
                                .await;
                        }
                    }
                }
                // サーバ Ping には tungstenite が自動で Pong を返す。Pong/Binary は無視。
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | None => return SessionOutcome::Disconnected,
                Some(Err(e)) => {
                    let _ = handle.net_tx
                        .send(NetEvent::NetError(format!("ws error: {e}")))
                        .await;
                    return SessionOutcome::Disconnected;
                }
            },
        }
    }
}

/// [`ClientFrame`] を JSON テキストフレームとして送る。
async fn send_frame<S>(
    sink: &mut S,
    frame: &ClientFrame,
    net_tx: &mpsc::Sender<NetEvent>,
) -> Result<(), ()>
where
    S: SinkExt<Message> + Unpin,
{
    let json = match serde_json::to_string(frame) {
        Ok(j) => j,
        Err(e) => {
            let _ = net_tx
                .send(NetEvent::NetError(format!("encode error: {e}")))
                .await;
            return Err(());
        }
    };
    sink.send(Message::Text(json)).await.map_err(|_| ())
}
