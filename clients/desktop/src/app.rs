//! アプリ状態と `eframe::App` 実装。
//!
//! 仕様: client_design.md §3 / architecture.md §8。
//!
//! - UI 状態（履歴・入力・接続状態・ログイン状態 等）を保持する。
//! - Net スレッドと `tokio::sync::mpsc` で疎結合（[`UiEvent`] / [`NetEvent`]）。
//! - 受信イベントで `ctx.request_repaint()` し、**それ以外は再描画しない**
//!   （イベント駆動で省電力。NFR-3）。
//! - ログイン / オーバーレイ / チャット / 設定 ビューを状態に応じてルーティング。

use tokio::sync::mpsc;

use crate::config::Settings;
use crate::model::{BotInfo, ServerFrame, StatusState};
use crate::net::{ConnectionState, LoginEvent, NetEvent, UiEvent};
use crate::ui::{self, ChatEntry};

/// ログイン UI のステート（ui/login.rs と共有）。
#[derive(Debug, Clone)]
pub enum LoginUiState {
    /// 未ログイン（「ブラウザでログイン」ボタン）。
    LoggedOut,
    /// デバイスコード取得中。
    Starting,
    /// 承認待ち（user_code 表示 + ポーリング）。
    AwaitingApproval {
        user_code: String,
        verification_uri: String,
    },
    /// エラー表示。
    Error(String),
}

/// 表示中のトップレベルビュー。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum View {
    /// 未ログイン → ログインビュー。
    Login,
    /// collapsed: オーブのみ（クリック透過）。
    Overlay,
    /// expanded: チャットモーダル。
    Chat,
    /// 設定。
    Settings,
}

/// UI → Net へ橋渡しする操作意図（ビュー関数が返し、`App` が `UiEvent` へ変換）。
#[derive(Debug, Clone)]
pub enum UiIntent {
    /// テキスト送信。
    SendText(String),
    /// 会話リセット。
    Reset,
    /// Bot 切替（WS 再接続）。
    SwitchBot { bot_id: String },
    /// ボタン押下（コンポーネント・インタラクション。ws_components.md §6）。
    Interaction {
        message_id: String,
        custom_id: String,
    },
}

/// UI 側が保持する全状態。各ビュー関数はこれを介して読み書きする。
pub struct AppState {
    // --- ビュー/ナビゲーション ---
    pub view: View,
    pub login: LoginUiState,

    // --- 接続/Bot ---
    pub connection: ConnectionState,
    /// 接続束縛中の Bot（`ready.bot`）。
    pub bot: Option<BotInfo>,
    /// 切替候補一覧（`ready.bots`）。
    pub bots: Vec<BotInfo>,

    // --- 会話 ---
    pub history: Vec<ChatEntry>,
    pub input: String,
    /// 現在のサーバステータス（None = アイドル）。
    pub status: Option<StatusState>,
    /// 未読通知件数（オーブのバッジ。モーダルを開くとクリア）。
    pub unread: u32,

    // --- 設定 ---
    pub settings: Settings,
    /// `ready.maxUploadMb`（送信前のローカル上限チェックに使う）。
    pub max_upload_mb: u32,

    // --- UI → アプリ制御のワンショットフラグ ---
    pub request_login_start: bool,
    pub request_logout: bool,

    // --- Markdown レンダリングキャッシュ（egui_commonmark）---
    pub commonmark_cache: egui_commonmark::CommonMarkCache,
}

impl AppState {
    fn new(settings: Settings) -> Self {
        AppState {
            view: View::Login,
            login: LoginUiState::LoggedOut,
            connection: ConnectionState::Disconnected,
            bot: None,
            bots: Vec::new(),
            history: Vec::new(),
            input: String::new(),
            status: None,
            unread: 0,
            settings,
            max_upload_mb: 20,
            request_login_start: false,
            request_logout: false,
            commonmark_cache: egui_commonmark::CommonMarkCache::default(),
        }
    }
}

/// `eframe::App` 本体。状態 + Net チャネル端点を保持する。
pub struct YuukaApp {
    state: AppState,
    /// UI → Net（送信要求・切替・停止）。
    ui_tx: mpsc::Sender<UiEvent>,
    /// Net → UI（フレーム・接続状態・エラー）。
    net_rx: mpsc::Receiver<NetEvent>,
    /// 現在ウィンドウへ適用中のクリック透過状態（変化時のみ送信する）。
    /// 起動時は main.rs の `with_mouse_passthrough(true)` に揃える。
    passthrough_active: bool,
}

impl YuukaApp {
    /// `App` を生成する。Net 側のチャネル端点（`ui_tx` 送信側 / `net_rx` 受信側）を
    /// 受け取る。WS タスクの spawn は `main.rs` が担う。
    pub fn new(
        settings: Settings,
        ui_tx: mpsc::Sender<UiEvent>,
        net_rx: mpsc::Receiver<NetEvent>,
    ) -> Self {
        YuukaApp {
            state: AppState::new(settings),
            ui_tx,
            net_rx,
            passthrough_active: true,
        }
    }

    /// Net から届いたイベントを排出して状態へ反映する。
    ///
    /// 1 件でも処理したら `true`（呼び出し側が `request_repaint`）。
    fn drain_net_events(&mut self) -> bool {
        let mut any = false;
        // ノンブロッキングで溜まっている分を全部引く。
        while let Ok(ev) = self.net_rx.try_recv() {
            any = true;
            match ev {
                NetEvent::Connection(conn) => {
                    self.state.connection = conn;
                }
                NetEvent::Frame(frame) => self.apply_frame(frame),
                NetEvent::NetError(msg) => {
                    log::warn!("net error: {msg}");
                }
                NetEvent::Login(ev) => self.apply_login_event(ev),
            }
        }
        any
    }

    /// デバイスフロー進捗（[`LoginEvent`]）を [`LoginUiState`] へ反映する。
    fn apply_login_event(&mut self, ev: LoginEvent) {
        match ev {
            LoginEvent::Code {
                user_code,
                verification_uri,
            } => {
                self.state.login = LoginUiState::AwaitingApproval {
                    user_code,
                    verification_uri,
                };
                self.state.view = View::Login;
            }
            // 承認待ち。AwaitingApproval のスピナー表示を継続するだけ。
            LoginEvent::Pending => {}
            // 承認完了。WS 接続 → `ready` 受領でオーバーレイへ遷移する（apply_frame）。
            LoginEvent::Succeeded => {}
            LoginEvent::Failed(msg) => {
                self.state.login = LoginUiState::Error(msg);
                self.state.view = View::Login;
            }
        }
    }

    /// サーバフレームを UI 状態へ適用する。
    fn apply_frame(&mut self, frame: ServerFrame) {
        match frame {
            ServerFrame::Ready {
                bot,
                bots,
                max_upload_mb,
                ..
            } => {
                self.state.bot = Some(bot);
                self.state.bots = bots;
                self.state.max_upload_mb = max_upload_mb;
                self.state.status = None;
                // 接続確立 → ログイン UI を初期状態へ戻し、オーバーレイへ。
                self.state.login = LoginUiState::LoggedOut;
                if matches!(self.state.view, View::Login) {
                    self.state.view = View::Overlay;
                }
            }
            ServerFrame::Status { state } => {
                self.state.status = Some(state);
            }
            ServerFrame::Interim { text } => {
                self.state.history.push(ChatEntry::assistant(text));
                self.bump_unread_if_collapsed();
            }
            ServerFrame::Token { delta } => {
                // v1 では送られない想定。来た場合は末尾 assistant 気泡へ追記。
                if let Some(last) = self.state.history.last_mut() {
                    if last.role == ui::Role::Assistant {
                        last.text.push_str(&delta);
                        return;
                    }
                }
                self.state.history.push(ChatEntry::assistant(delta));
            }
            ServerFrame::Done {
                message_id,
                text,
                embeds,
                files,
                components,
                ..
            } => {
                self.state.status = None;
                self.state.history.push(ChatEntry {
                    role: ui::Role::Assistant,
                    text,
                    embeds,
                    files,
                    message_id: Some(message_id),
                    components,
                });
                self.bump_unread_if_collapsed();
            }
            ServerFrame::Push {
                message_id,
                text,
                embeds,
                files,
                components,
            } => {
                // 重い処理の完了プッシュ（モーダル閉でも通知。FR-9）。
                self.state.history.push(ChatEntry {
                    role: ui::Role::Assistant,
                    text,
                    embeds,
                    files,
                    message_id,
                    components,
                });
                self.bump_unread_if_collapsed();
            }
            ServerFrame::Update {
                message_id,
                text,
                components,
                ..
            } => {
                // 履歴中の該当メッセージを探し、存在するフィールドのみ差し替える
                // （components:[] でボタン除去。ws_components.md §2）。
                if let Some(entry) = self
                    .state
                    .history
                    .iter_mut()
                    .find(|e| e.message_id.as_deref() == Some(message_id.as_str()))
                {
                    if let Some(text) = text {
                        entry.text = text;
                    }
                    if let Some(components) = components {
                        entry.components = components;
                    }
                }
            }
            ServerFrame::Error { code, message } => {
                use crate::model::ErrorCode;
                match code {
                    ErrorCode::Unauthorized => {
                        // トークン失効 → 再ログインへ（保存トークン破棄は main/net 側）。
                        self.state.login = LoginUiState::LoggedOut;
                        self.state.view = View::Login;
                    }
                    _ => {
                        self.state
                            .history
                            .push(ChatEntry::assistant(format!("⚠ {message}")));
                    }
                }
                self.state.status = None;
            }
        }
    }

    /// オーブ表示中（モーダル非表示）のときだけ未読カウントを増やす。
    fn bump_unread_if_collapsed(&mut self) {
        if !matches!(self.state.view, View::Chat) {
            self.state.unread += 1;
        }
    }

    /// ビュー関数が返した [`UiIntent`] を [`UiEvent`] に変換して Net へ送る。
    fn dispatch_intent(&self, intent: UiIntent) {
        let event = match intent {
            UiIntent::SendText(text) => UiEvent::Send(crate::model::ClientFrame::text(text)),
            UiIntent::Reset => UiEvent::Send(crate::model::ClientFrame::Reset),
            UiIntent::SwitchBot { bot_id } => UiEvent::SwitchBot { bot_id },
            UiIntent::Interaction {
                message_id,
                custom_id,
            } => UiEvent::Send(crate::model::ClientFrame::Interaction {
                message_id,
                custom_id,
            }),
        };
        // UI スレッドからは try_send（満杯時は取りこぼすより警告）。
        if let Err(e) = self.ui_tx.try_send(event) {
            log::warn!("failed to enqueue ui event: {e}");
        }
    }
}

impl eframe::App for YuukaApp {
    /// 透明オーバーレイのため背景はクリアカラーを透過にする。
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0, 0.0, 0.0, 0.0]
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // --- Net イベント排出（受信があれば再描画。NFR-3 イベント駆動）---
        if self.drain_net_events() {
            ctx.request_repaint();
        }

        // --- ワンショットフラグの処理（ログイン開始/ログアウト要求）---
        if std::mem::take(&mut self.state.request_login_start) {
            // Net スレッドへデバイスフロー開始を依頼する（端末名を添える）。
            // 進捗は NetEvent::Login で返り、apply_login_event が UI を更新する。
            if let Err(e) = self.ui_tx.try_send(UiEvent::StartLogin {
                device_name: crate::config::device_name(),
            }) {
                log::warn!("failed to enqueue login start: {e}");
                self.state.login = LoginUiState::Error(
                    "ログインを開始できませんでした。もう一度お試しください。".into(),
                );
            }
        }
        if std::mem::take(&mut self.state.request_logout) {
            // トークン破棄 → 未ログインへ。Net スレッドは生かしたまま再ログインを待つ。
            let _ = self.ui_tx.try_send(UiEvent::Logout);
            self.state.view = View::Login;
            self.state.login = LoginUiState::LoggedOut;
            // 直近の会話/Bot 表示はクリアして再ログイン後の混線を防ぐ。
            self.state.history.clear();
            self.state.bot = None;
            self.state.bots.clear();
        }

        // --- クリック透過の切り替え ---
        // Overlay（オーブのみ）は周囲を透過させ背面アプリを操作可能にするが、
        // それ以外（Login/Chat/Settings）は不透過にしないとボタンを押せず、
        // 透明背景と相まって「何も出ない / 触れない」状態になる。
        // 変化時のみ ViewportCommand を送る（毎フレーム送出を避ける）。
        let want_passthrough = matches!(self.state.view, View::Overlay);
        if want_passthrough != self.passthrough_active {
            ctx.send_viewport_cmd(egui::ViewportCommand::MousePassthrough(want_passthrough));
            self.passthrough_active = want_passthrough;
        }

        // --- ビューのルーティング ---
        let mut intent: Option<UiIntent> = None;
        match self.state.view {
            View::Login => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    ui::login::view(&mut self.state, ui);
                });
            }
            View::Overlay => {
                // collapsed: オーブのみ。クリックでチャットへ。
                egui::CentralPanel::default()
                    .frame(egui::Frame::none()) // 透明背景
                    .show(ctx, |ui| {
                        if ui::overlay::view(&mut self.state, ui) {
                            self.state.view = View::Chat;
                            self.state.unread = 0; // モーダルを開いたら未読クリア。
                        }
                    });
            }
            View::Chat => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    // ヘッダにオーバーレイへ戻る / 設定導線。
                    ui.horizontal(|ui| {
                        if ui.button("⤫ 閉じる").clicked() {
                            self.state.view = View::Overlay;
                        }
                        if ui.button("⚙ 設定").clicked() {
                            self.state.view = View::Settings;
                        }
                    });
                    ui.separator();
                    intent = ui::chat::view(&mut self.state, ui);
                });
            }
            View::Settings => {
                egui::CentralPanel::default().show(ctx, |ui| {
                    if ui.button("← 戻る").clicked() {
                        self.state.view = View::Chat;
                    }
                    ui.separator();
                    if ui::settings::view(&mut self.state, ui) {
                        // 設定変更 → 永続化（非機微のみ）。
                        if let Err(e) = self.state.settings.save() {
                            log::warn!("failed to save settings: {e}");
                        }
                    }
                });
            }
        }

        // ビューから返った操作意図を Net へ橋渡し。
        if let Some(intent) = intent {
            self.dispatch_intent(intent);
        }

        // Esc でチャット → オーバーレイへ（client_design.md §4.1）。
        if matches!(self.state.view, View::Chat) && ctx.input(|i| i.key_pressed(egui::Key::Escape))
        {
            self.state.view = View::Overlay;
        }
    }

    /// 終了時に設定を保存し、Net タスクへ停止を伝える。
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        let _ = self.state.settings.save();
        let _ = self.ui_tx.try_send(UiEvent::Shutdown);
    }
}
