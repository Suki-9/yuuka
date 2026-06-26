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
use crate::os::{self, OsIntegration};
use crate::ui::{self, ChatEntry};

/// オーブのヒット領域を視覚サイズより広げる余白（**物理ピクセル**）。
///
/// カーソルがオーブへ到達する少し手前でクリック透過を解除し、「ホバーした瞬間に
/// 押せない」体感（透過 ON→OFF の 1 フレーム遅延）を緩和する。
const ORB_HOVER_MARGIN_PX: f32 = 10.0;

/// オーバーレイ表示中に OS カーソルをポーリングする間隔。
///
/// クリック透過中は egui がマウス移動を受け取れず再描画も起きないため、自前で
/// 定期再描画してカーソルのオーブ進入を検知する（collapsed の間だけの軽い負荷）。
const OVERLAY_CURSOR_POLL: std::time::Duration = std::time::Duration::from_millis(50);

/// collapsed（オーブ）時のウィンドウ一辺（論理 px）。オーブ直径 + バッジ/余白ぶん。
/// この小さな窓を画面上にドラッグして常駐させる（client_design.md §4.1）。
pub const ORB_WINDOW_SIZE: f32 = 76.0;

/// expanded（ログイン / チャット / 設定）時のウィンドウ内寸（論理 px）。
/// collapsed↔expanded は単一ビューポートをリサイズして表現する（client_design.md §4.1）。
pub const PANEL_WINDOW_SIZE: [f32; 2] = [380.0, 600.0];

/// 保存された左上座標を、ウィンドウ全体がモニタ内に収まるよう丸める。
///
/// `monitor` 不明（起動直後の数フレーム）なら負値だけ 0 に丸めて返す。これにより
/// 復元位置が画面外（オーブが見えず「触れない」）になる事故を防ぐ（純粋関数＝テスト可）。
fn clamp_top_left(pos: egui::Pos2, size: egui::Vec2, monitor: Option<egui::Vec2>) -> egui::Pos2 {
    let Some(mon) = monitor else {
        return egui::pos2(pos.x.max(0.0), pos.y.max(0.0));
    };
    let max_x = (mon.x - size.x).max(0.0);
    let max_y = (mon.y - size.y).max(0.0);
    egui::pos2(pos.x.clamp(0.0, max_x), pos.y.clamp(0.0, max_y))
}

/// egui に日本語フォントを登録する（eframe 起動時に一度だけ呼ぶ）。
///
/// egui の既定フォント（`default_fonts`）はラテン系のみで CJK グリフを持たないため、
/// 何もしないと日本語は豆腐（□）になる。OS の日本語フォントを実行時に読み込み、
/// Proportional / Monospace の先頭へ差し込む。配布サイズを増やさない方針（NFR-1）。
pub fn install_fonts(ctx: &egui::Context) {
    // OS 標準の日本語フォント候補（最初に読めたものを使う）。
    // .ttc（フォントコレクション）も egui::FontData が index 0 で扱える。
    #[cfg(windows)]
    const CANDIDATES: &[&str] = &[
        r"C:\Windows\Fonts\YuGothM.ttc",  // 游ゴシック Medium
        r"C:\Windows\Fonts\YuGothR.ttc",  // 游ゴシック Regular
        r"C:\Windows\Fonts\meiryo.ttc",   // メイリオ
        r"C:\Windows\Fonts\msgothic.ttc", // MS ゴシック
    ];
    #[cfg(not(windows))]
    const CANDIDATES: &[&str] = &[
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-JP-Regular.otf",
        "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
        "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    ];

    for path in CANDIDATES {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        // 重要: 「読めた」≠「フォントとして妥当」。妥当でないバイト列を set_fonts へ
        // 渡すと、egui/epaint がアトラス構築時（最初のフレーム）に panic する
        // （epaint fonts.rs: `Error parsing ... TTF/OTF font file`）。リリースは
        // panic="abort" かつ Windows は windows_subsystem="windows" のため、画面も
        // コンソールも出ずにプロセスが即終了する＝「起動すらしない」。catch_unwind は
        // panic=abort 下では効かないので、egui と同じ ab_glyph で**事前検証**し、
        // 駄目なら次の候補へフォールバックする（参照渡しでコピーを避ける）。
        if let Err(e) = ab_glyph::FontRef::try_from_slice_and_index(&bytes, 0) {
            log::warn!("font at {path} is not a parseable TTF/OTF/TTC ({e}); skipping");
            continue;
        }
        let mut fonts = egui::FontDefinitions::default();
        fonts
            .font_data
            .insert("jp".to_owned(), egui::FontData::from_owned(bytes));
        // 先頭へ差し込む＝日本語を最優先で解決し、欠落グリフは既定フォントへフォールバック。
        for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
            fonts.families.entry(family).or_default().insert(0, "jp".to_owned());
        }
        ctx.set_fonts(fonts);
        log::info!("loaded Japanese font: {path}");
        return;
    }
    // 1 つも妥当な日本語フォントが見つからなくても、既定フォントのまま**起動は続行する**
    // （日本語は豆腐 □ になるが、無言で落ちるよりはるかに良い）。
    log::warn!("no usable Japanese font found; CJK may render as tofu (□), but the app will still start");
}

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
    /// 認証成功。Bot 解決 + WS 接続中（`ready` 受領でオーバーレイへ遷移）。
    Connecting,
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

    /// 直近フレームでオーブが描かれたウィンドウ内矩形（egui points）。
    /// クリック透過をオーブ上だけ解除するためのヒット判定に使う（overlay::view が更新）。
    pub orb_rect: Option<egui::Rect>,

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
            orb_rect: None,
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
    /// OS 統合（オーブ上ホバー判定のための物理カーソル取得に使う）。
    os: os::PlatformOs,
    /// 直前フレームのビュー（collapsed↔expanded のサイズ切替を検知する）。
    last_view: Option<View>,
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
            os: os::platform(),
            last_view: None,
        }
    }

    /// ウィンドウのサイズ/位置を現在のビューへ追従させる（client_design.md §4.1）。
    ///
    /// - collapsed（Overlay）= オーブ大の小窓、expanded（その他）= パネル大。
    /// - **オーブが絡む遷移のときだけ**ウィンドウを作り替える（`InnerSize`+`OuterPosition`）。
    ///   位置は記憶したオーブ座標へアンカーし、画面外へ出ないよう丸める。起動直後の
    ///   ログイン（オーブ未経由）は OS の配置のまま／パネル同士（Chat↔Settings）は動かさない。
    /// - collapsed の間はドラッグ後の左上座標を `overlay_pos` に記憶し続ける（次回復元用）。
    fn manage_window_geometry(&mut self, ctx: &egui::Context) {
        let is_orb = matches!(self.state.view, View::Overlay);
        let was_orb = self.last_view.map(|v| matches!(v, View::Overlay));
        let class_changed = was_orb != Some(is_orb);
        // オーブ↔パネルの遷移か（少なくとも片側がオーブ）。
        let involves_orb = is_orb || was_orb == Some(true);

        if class_changed && involves_orb {
            let monitor = ctx.input(|i| i.viewport().monitor_size);
            let size = if is_orb {
                egui::vec2(ORB_WINDOW_SIZE, ORB_WINDOW_SIZE)
            } else {
                egui::vec2(PANEL_WINDOW_SIZE[0], PANEL_WINDOW_SIZE[1])
            };
            // collapsed から離れる直前に、ドラッグで動かしたオーブ位置を永続化しておく
            // （強制終了でも次回はその位置から復元できる）。
            if was_orb == Some(true) {
                let _ = self.state.settings.save();
            }
            let pos = clamp_top_left(self.overlay_anchor(), size, monitor);
            ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(size));
            ctx.send_viewport_cmd(egui::ViewportCommand::OuterPosition(pos));
        }
        self.last_view = Some(self.state.view);

        // collapsed の間は、ユーザーがドラッグして決めた左上座標を記憶する。
        if is_orb {
            if let Some(rect) = ctx.input(|i| i.viewport().outer_rect) {
                self.state.settings.overlay_pos = crate::config::OverlayPos {
                    x: rect.min.x,
                    y: rect.min.y,
                };
            }
        }
    }

    /// 記憶しているオーブの左上座標（ウィンドウ位置のアンカー）。
    fn overlay_anchor(&self) -> egui::Pos2 {
        egui::pos2(
            self.state.settings.overlay_pos.x,
            self.state.settings.overlay_pos.y,
        )
    }

    /// OS のカーソルがオーブの上にあるか。判定不能（OS 非対応・窓位置やオーブ矩形が
    /// 未確定）なら `None`。
    ///
    /// クリック透過中は egui がマウス座標を受け取れないため、OS から**物理ピクセル**の
    /// カーソル位置を取り、オーブのスクリーン矩形（少し広げたヒット領域）と内外判定する。
    /// `inner_rect` は monitor 空間の points なので、`pixels_per_point` を掛けて物理 px へ
    /// 揃えてから比較する（`GetCursorPos` と同じ仮想デスクトップ原点・物理スケール）。
    fn cursor_over_orb(&self, ctx: &egui::Context) -> Option<bool> {
        let orb = self.state.orb_rect?; // ウィンドウ内 points（左上=窓左上）
        let inner = ctx.input(|i| i.viewport().inner_rect)?; // monitor 空間 points
        let (cx, cy) = self.os.cursor_pos_physical()?; // 物理スクリーン px
        let ppp = ctx.pixels_per_point();
        let screen_points = egui::Rect::from_min_size(inner.min + orb.min.to_vec2(), orb.size());
        let hit = (screen_points * ppp).expand(ORB_HOVER_MARGIN_PX);
        Some(hit.contains(egui::pos2(cx, cy)))
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
            // 承認完了。Bot 解決 + WS 接続中の表示にする（`ready` 受領で apply_frame が
            // オーバーレイへ遷移）。これが無いと成功後も「承認待ち」のまま見えてしまう。
            LoginEvent::Succeeded => {
                self.state.login = LoginUiState::Connecting;
            }
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

        // --- クリック透過の切り替え（オーブ上だけヒット・周囲は透過）---
        // Overlay（collapsed）は背面アプリを操作できるよう周囲を透過させるが、
        // ウィンドウ単位の透過は全域に効くため、素朴に透過 ON にするとオーブ自身も
        // クリックできずモーダルを開けない。そこで OS カーソルがオーブの上にある間
        // だけ透過 OFF にして、オーブへのクリックを通す（client_design.md §4.2）。
        // OS カーソルを取れない環境（非 Windows 等）や矩形未確定時は安全側＝透過 OFF
        // （オーブは確実に押せる。代わりにウィンドウ矩形がクリックを奪う）。
        // それ以外のビュー（Login/Chat/Settings）は常に不透過（ボタン操作のため）。
        let want_passthrough = match self.state.view {
            View::Overlay => self.cursor_over_orb(ctx).map(|over| !over).unwrap_or(false),
            _ => false,
        };
        if want_passthrough != self.passthrough_active {
            ctx.send_viewport_cmd(egui::ViewportCommand::MousePassthrough(want_passthrough));
            self.passthrough_active = want_passthrough;
        }
        // 透過中は egui がマウス移動を受け取れず再描画も起きないため、Overlay の間は
        // 定期再描画して OS カーソルのオーブ進入をポーリングする（collapsed 限定の軽負荷）。
        if matches!(self.state.view, View::Overlay) {
            ctx.request_repaint_after(OVERLAY_CURSOR_POLL);
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

        // 本フレームで確定したビューへウィンドウのサイズ/位置を追従させる
        // （collapsed=小窓 / expanded=パネル。オーブのドラッグ位置も記憶する）。
        self.manage_window_geometry(ctx);
    }

    /// 終了時に設定を保存し、Net タスクへ停止を伝える。
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        let _ = self.state.settings.save();
        let _ = self.ui_tx.try_send(UiEvent::Shutdown);
    }
}

#[cfg(test)]
mod tests {
    use super::clamp_top_left;

    #[test]
    fn clamp_keeps_in_bounds_position_unchanged() {
        let mon = Some(egui::vec2(1920.0, 1080.0));
        // パネル（380x600）が完全に収まる位置はそのまま。
        let p = clamp_top_left(egui::pos2(100.0, 50.0), egui::vec2(380.0, 600.0), mon);
        assert_eq!(p, egui::pos2(100.0, 50.0));
    }

    #[test]
    fn clamp_pulls_offscreen_window_back_onto_monitor() {
        let mon = Some(egui::vec2(1920.0, 1080.0));
        // 既定 overlay_pos(1200,700) にオーブ大(76)を置くと下端が画面外 → 丸められる。
        let p = clamp_top_left(egui::pos2(1900.0, 1050.0), egui::vec2(76.0, 76.0), mon);
        assert_eq!(p, egui::pos2(1920.0 - 76.0, 1080.0 - 76.0));
    }

    #[test]
    fn clamp_without_monitor_only_floors_negatives() {
        // モニタ不明時は負値だけ 0 へ（過剰に動かさない）。
        let p = clamp_top_left(egui::pos2(-30.0, 700.0), egui::vec2(76.0, 76.0), None);
        assert_eq!(p, egui::pos2(0.0, 700.0));
    }

    #[test]
    fn clamp_window_larger_than_monitor_pins_to_origin() {
        let mon = Some(egui::vec2(60.0, 60.0));
        // 窓がモニタより大きい異常系でも NaN/負値を出さず原点に固定。
        let p = clamp_top_left(egui::pos2(500.0, 500.0), egui::vec2(76.0, 76.0), mon);
        assert_eq!(p, egui::pos2(0.0, 0.0));
    }
}
