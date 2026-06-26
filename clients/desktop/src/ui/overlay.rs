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
//! アイコンは Net 側が取得した画像バイト（`AppState::avatars`）を egui の画像ローダ越しに
//! 円形描画する。未取得/デコード中は背景円＋Bot 名頭文字のプレースホルダを見せる。

use crate::app::AppState;

/// オーブ 1 個分の直径（論理ピクセル）。
const ORB_DIAMETER: f32 = 56.0;

/// オーブビューを描画する。クリックされたら `true`（モーダルを開く合図）。
pub fn view(state: &mut AppState, ui: &mut egui::Ui) -> bool {
    let mut clicked = false;

    // 小さな collapsed 窓の中央にオーブを置く（窓＝オーブ大なので中央寄せで安定）。
    let full = ui.available_rect_before_wrap();
    let rect = egui::Rect::from_center_size(full.center(), egui::vec2(ORB_DIAMETER, ORB_DIAMETER));
    let response = ui.allocate_rect(rect, egui::Sense::click_and_drag());

    // app.rs のクリック透過判定（オーブ上だけ透過 OFF）に使うため、描画した
    // オーブ矩形（ウィンドウ内 points）を記録する。
    state.orb_rect = Some(rect);

    let center = rect.center();
    let radius = ORB_DIAMETER / 2.0;

    // 背景プレースホルダ円（アイコン未取得/デコード中もこれが見える＝オーブが消えない）。
    let fill = if response.hovered() {
        egui::Color32::from_rgb(90, 130, 200)
    } else {
        egui::Color32::from_rgb(70, 110, 180)
    };
    ui.painter().circle_filled(center, radius, fill);

    // 接続中 Bot のアイコンが取得済みなら、背景円の上へ円形にクリップして重ねる。
    let bound_id = state.bot.as_ref().map(|b| b.id.clone());
    let avatar = bound_id
        .as_ref()
        .and_then(|id| state.avatars.get(id).cloned());
    if let (Some(id), Some(bytes)) = (bound_id.as_ref(), avatar) {
        egui::Image::new(egui::ImageSource::Bytes {
            // uri は bot_id 毎に安定 → egui がデコード済みテクスチャをキャッシュする。
            uri: crate::app::avatar_uri(id).into(),
            bytes,
        })
        .rounding(egui::Rounding::same(radius))
        .paint_at(ui, rect);
    } else {
        // 頭文字プレースホルダ（アイコン未取得時）。
        let initial = state
            .bot
            .as_ref()
            .and_then(|b| b.name.chars().next())
            .unwrap_or('Y')
            .to_string();
        ui.painter().text(
            center,
            egui::Align2::CENTER_CENTER,
            initial,
            egui::FontId::proportional(24.0),
            egui::Color32::WHITE,
        );
    }

    // 通知バッジ（右上に未読件数）。モーダルを開くとクリアされる（app.rs 側）。
    if state.unread > 0 {
        let badge_center = egui::pos2(rect.right() - 8.0, rect.top() + 8.0);
        let painter = ui.painter();
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

    // ドラッグ開始で OS ネイティブのウィンドウ移動を始める（枠なし窓を掴んで動かす）。
    // 移動後の左上座標は app.rs が `outer_rect` から読み取り `overlay_pos` へ記憶する。
    // タップ（移動なし）は `clicked`、しきい値を超える動きは `drag_started` に分かれるため
    // 「掴んで動かす」と「押して開く」が衝突しない。
    if response.drag_started() {
        ui.ctx().send_viewport_cmd(egui::ViewportCommand::StartDrag);
    }
    // 移動可能であることを示すためカーソルを grab 表示にする。
    if response.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::Grab);
    }

    clicked
}
