//! オーバーレイ（オーブ）ビュー。
//!
//! 仕様: client_design.md §4.1 / requirements.md FR-2 / FR-2b。
//!
//! - collapsed（オーブ）: **接続中 Bot のアイコン**を円形に描画。右上に通知バッジ
//!   （未読件数）。ドラッグで移動・位置記憶。クリックでモーダルを開く。
//! - 周囲は透過し、オーブ部のみヒットさせる。eframe の `mouse_passthrough` は
//!   ウィンドウ単位（全域）にしか効かないため、`app.rs` 側で OS カーソル位置と
//!   このオーブ矩形（`AppState::orb_rect` に毎フレーム記録）を突き合わせ、カーソルが
//!   オーブ上にある間だけ透過を解除する（client_design.md §4.2 / `os::cursor_pos_physical`）。
//!
//! 本フェーズはアイコン画像ロード（egui_extras）を省き、Bot 名頭文字の
//! プレースホルダ円で描画する（client_design.md §4.1）。

use crate::app::AppState;

/// オーブ 1 個分の直径（論理ピクセル）。
const ORB_DIAMETER: f32 = 56.0;

/// オーブビューを描画する。クリックされたら `true`（モーダルを開く合図）。
pub fn view(state: &mut AppState, ui: &mut egui::Ui) -> bool {
    let mut clicked = false;

    // オーブ円の領域を確保。ドラッグ移動はビューポート移動として Phase 5 で配線。
    let (rect, response) = ui.allocate_exact_size(
        egui::vec2(ORB_DIAMETER, ORB_DIAMETER),
        egui::Sense::click_and_drag(),
    );

    // app.rs のクリック透過判定（オーブ上だけ透過 OFF）に使うため、描画した
    // オーブ矩形（ウィンドウ内 points）を記録する。
    state.orb_rect = Some(rect);

    let painter = ui.painter();
    let center = rect.center();
    let radius = ORB_DIAMETER / 2.0;

    // プレースホルダ円（接続中 Bot のアバター取得前 / 取得後は画像で置換予定）。
    let fill = if response.hovered() {
        egui::Color32::from_rgb(90, 130, 200)
    } else {
        egui::Color32::from_rgb(70, 110, 180)
    };
    painter.circle_filled(center, radius, fill);

    // Bot 名の頭文字（プレースホルダ）。
    let initial = state
        .bot
        .as_ref()
        .and_then(|b| b.name.chars().next())
        .unwrap_or('Y')
        .to_string();
    painter.text(
        center,
        egui::Align2::CENTER_CENTER,
        initial,
        egui::FontId::proportional(24.0),
        egui::Color32::WHITE,
    );

    // 通知バッジ（右上に未読件数）。モーダルを開くとクリアされる（app.rs 側）。
    if state.unread > 0 {
        let badge_center = egui::pos2(rect.right() - 8.0, rect.top() + 8.0);
        painter.circle_filled(badge_center, 9.0, egui::Color32::from_rgb(220, 60, 60));
        painter.text(
            badge_center,
            egui::Align2::CENTER_CENTER,
            state.unread.to_string(),
            egui::FontId::proportional(11.0),
            egui::Color32::WHITE,
        );
    }

    if response.clicked() {
        clicked = true;
    }

    // ドラッグ中はオーブ位置を更新（実際のウィンドウ移動は Phase 5 で
    // ViewportCommand::OuterPosition と連動）。
    if response.dragged() {
        let delta = response.drag_delta();
        state.settings.overlay_pos.x += delta.x;
        state.settings.overlay_pos.y += delta.y;
    }

    clicked
}
