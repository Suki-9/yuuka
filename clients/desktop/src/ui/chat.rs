//! チャットモーダルビュー（履歴・入力・ステータス・Bot 切替）。
//!
//! 仕様: client_design.md §5 / requirements.md FR-4 / FR-7 / FR-8 / FR-11 / FR-12。
//!
//! 本フェーズの骨格に含むもの:
//! - 履歴ビュー（role で色分け、assistant は MD レンダリング）
//! - ステータス行（thinking/writing のスピナー）
//! - 入力欄（Enter 送信 / Shift+Enter 改行）
//! - Bot 切替 ComboBox（選択 = WS 再接続）
//! - 会話クリア（reset）/ 接続状態表示
//!
//! 画像添付・録音ボタンは Phase 3/4 で追加するため、ここではプレースホルダのみ。

use egui_commonmark::CommonMarkViewer;

use crate::app::{AppState, UiIntent};
use crate::model::StatusState;
use crate::net::ConnectionState;

use super::Role;

/// チャットモーダルを描画し、ユーザー操作を [`UiIntent`] として返す。
///
/// 返した intent は `app.rs` が Net スレッドへ橋渡しする（UI とネットの疎結合）。
pub fn view(state: &mut AppState, ui: &mut egui::Ui) -> Option<UiIntent> {
    let mut intent: Option<UiIntent> = None;

    // --- ヘッダ: Bot 切替セレクタ + 接続状態 + 会話クリア ---
    ui.horizontal(|ui| {
        bot_selector(state, ui, &mut intent);
        ui.separator();
        connection_label(&state.connection, ui);
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("会話をクリア").clicked() {
                intent = Some(UiIntent::Reset);
                state.history.clear();
            }
        });
    });
    ui.separator();

    // --- 履歴ビュー ---
    egui::ScrollArea::vertical()
        .auto_shrink([false, false])
        .stick_to_bottom(true)
        .show(ui, |ui| {
            for entry in &state.history {
                if let Some(i) = message_bubble(entry, ui, &mut state.commonmark_cache) {
                    intent = Some(i);
                }
            }

            // ステータス行（考え中…/入力中…）。
            if let Some(status) = &state.status {
                ui.horizontal(|ui| {
                    ui.spinner();
                    let label = match status {
                        StatusState::Thinking => "考え中…",
                        StatusState::Writing => "入力中…",
                        StatusState::Other => "処理中…",
                    };
                    ui.label(label);
                });
            }
        });

    ui.separator();

    // --- 入力欄（Enter 送信 / Shift+Enter 改行）---
    ui.horizontal(|ui| {
        let send_enabled =
            state.status.is_none() && matches!(state.connection, ConnectionState::Connected { .. });

        let text_edit = egui::TextEdit::multiline(&mut state.input)
            .hint_text("メッセージを入力（Enter 送信 / Shift+Enter 改行）")
            .desired_rows(2)
            .desired_width(f32::INFINITY);
        let resp = ui.add_enabled(send_enabled, text_edit);

        // Enter（Shift 無し）で送信。
        let enter_pressed =
            resp.has_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter) && !i.modifiers.shift);

        let send_clicked = ui
            .add_enabled(send_enabled, egui::Button::new("送信"))
            .clicked();

        if send_enabled && (enter_pressed || send_clicked) {
            let text = state.input.trim().to_string();
            if !text.is_empty() {
                state.history.push(super::ChatEntry::user(text.clone()));
                state.input.clear();
                intent = Some(UiIntent::SendText(text));
            }
        }
    });

    // 添付/録音ボタン（Phase 3/4 で実装）。
    ui.horizontal(|ui| {
        ui.add_enabled(false, egui::Button::new("画像添付 (Phase 3)"));
        ui.add_enabled(false, egui::Button::new("録音 (Phase 4)"));
    });

    intent
}

/// Bot 切替セレクタ（選択で WS 再接続 = [`UiIntent::SwitchBot`]）。
fn bot_selector(state: &mut AppState, ui: &mut egui::Ui, intent: &mut Option<UiIntent>) {
    let current_name = state
        .bot
        .as_ref()
        .map(|b| b.name.clone())
        .unwrap_or_else(|| "(未接続)".to_string());

    egui::ComboBox::from_id_salt("bot-selector")
        .selected_text(current_name)
        .show_ui(ui, |ui| {
            // `bots` のクローンを回して借用衝突を避ける。
            let bots = state.bots.clone();
            for bot in &bots {
                let selected = state.bot.as_ref().map(|b| &b.id) == Some(&bot.id);
                if ui.selectable_label(selected, &bot.name).clicked() && !selected {
                    *intent = Some(UiIntent::SwitchBot {
                        bot_id: bot.id.clone(),
                    });
                }
            }
        });
}

/// 接続状態の小ラベル（オフライン/再接続中をヘッダに表示。client_design.md §5）。
fn connection_label(conn: &ConnectionState, ui: &mut egui::Ui) {
    let (text, color) = match conn {
        ConnectionState::Connected { .. } => ("オンライン", egui::Color32::from_rgb(80, 200, 120)),
        ConnectionState::Connecting => ("接続中…", egui::Color32::GRAY),
        ConnectionState::Reconnecting { next_retry_secs } => {
            return {
                ui.colored_label(
                    egui::Color32::from_rgb(230, 180, 80),
                    format!("再接続中… ({next_retry_secs}s)"),
                );
            };
        }
        ConnectionState::Disconnected => ("オフライン", egui::Color32::from_rgb(200, 80, 80)),
    };
    ui.colored_label(color, text);
}

/// 1 メッセージの気泡描画（role で色分け、assistant は MD）。
///
/// ボタン押下があれば [`UiIntent::Interaction`] を返す（ws_components.md §6）。
fn message_bubble(
    entry: &super::ChatEntry,
    ui: &mut egui::Ui,
    cache: &mut egui_commonmark::CommonMarkCache,
) -> Option<UiIntent> {
    let mut intent: Option<UiIntent> = None;
    let (align, frame_fill) = match entry.role {
        Role::User => (egui::Align::Max, egui::Color32::from_rgb(60, 90, 140)),
        Role::Assistant => (egui::Align::Min, egui::Color32::from_rgb(45, 45, 55)),
    };

    ui.with_layout(egui::Layout::top_down(align), |ui| {
        egui::Frame::none()
            .fill(frame_fill)
            .inner_margin(egui::Margin::same(8.0))
            .rounding(egui::Rounding::same(8.0))
            .show(ui, |ui| {
                ui.set_max_width(ui.available_width() * 0.85);
                match entry.role {
                    Role::User => {
                        ui.label(&entry.text);
                    }
                    Role::Assistant => {
                        // Markdown レンダリング（コードブロック/リスト/リンク）。
                        CommonMarkViewer::new().show(ui, cache, &entry.text);
                    }
                }

                // Embed カード（最低限の表示。Phase 3 で画像インライン化）。
                for embed in &entry.embeds {
                    embed_card(embed, ui);
                }
                // files のインライン画像表示も Phase 3。
                if !entry.files.is_empty() {
                    ui.weak(format!(
                        "(添付ファイル {} 件 — Phase 3 で表示)",
                        entry.files.len()
                    ));
                }

                // 対話コンポーネント（action row）= 横並びのボタン列。
                for row in &entry.components {
                    if let Some(i) = action_row(row, entry.message_id.as_deref(), ui) {
                        intent = Some(i);
                    }
                }
            });
    });
    ui.add_space(4.0);
    intent
}

/// 1 つの action row を横並びのボタン列として描画する（ws_components.md §6）。
fn action_row(
    row: &crate::model::ActionRow,
    message_id: Option<&str>,
    ui: &mut egui::Ui,
) -> Option<UiIntent> {
    use crate::model::Component;
    let mut intent: Option<UiIntent> = None;
    ui.horizontal_wrapped(|ui| {
        for comp in &row.components {
            // 行内に現れるのはボタンのみ想定。Row/Unknown は描画しない。
            let Component::Button {
                style,
                label,
                custom_id,
                url,
                disabled,
            } = comp
            else {
                continue;
            };

            let text = label.clone().unwrap_or_default();
            let button = egui::Button::new(text).fill(button_color(*style));
            let resp = ui.add_enabled(!*disabled, button);

            if resp.clicked() {
                if *style == 5 {
                    // Link ボタン: 既定ブラウザで URL を開く（送信しない）。
                    if let Some(url) = url {
                        let _ = open::that_detached(url);
                    }
                } else if let (Some(message_id), Some(custom_id)) = (message_id, custom_id) {
                    // 非 Link ボタン: interaction を発火（message_id と custom_id 必須）。
                    intent = Some(UiIntent::Interaction {
                        message_id: message_id.to_string(),
                        custom_id: custom_id.clone(),
                    });
                }
            }
        }
    });
    intent
}

/// Discord スタイル番号を気泡ボタンの塗り色へ対応づける（ws_components.md §1）。
/// 1=Primary(青) 2=Secondary(灰) 3=Success(緑) 4=Danger(赤) 5=Link(リンク表示)。
fn button_color(style: u8) -> egui::Color32 {
    match style {
        1 => egui::Color32::from_rgb(60, 110, 200),  // Primary 青
        3 => egui::Color32::from_rgb(60, 160, 90),   // Success 緑
        4 => egui::Color32::from_rgb(200, 70, 70),   // Danger 赤
        5 => egui::Color32::from_rgb(70, 90, 130),   // Link リンク調
        _ => egui::Color32::from_rgb(90, 90, 100),   // Secondary 灰（既定）
    }
}

/// Embed カードの最低限描画（タイトル/本文/色帯/フィールド）。
fn embed_card(embed: &crate::model::Embed, ui: &mut egui::Ui) {
    let stripe = embed
        .color
        .map(|c| {
            egui::Color32::from_rgb(
                ((c >> 16) & 0xFF) as u8,
                ((c >> 8) & 0xFF) as u8,
                (c & 0xFF) as u8,
            )
        })
        .unwrap_or(egui::Color32::GRAY);

    egui::Frame::none()
        .fill(egui::Color32::from_rgb(35, 35, 42))
        .stroke(egui::Stroke::new(3.0, stripe))
        .inner_margin(egui::Margin::same(6.0))
        .show(ui, |ui| {
            if let Some(title) = &embed.title {
                ui.strong(title);
            }
            if let Some(desc) = &embed.description {
                ui.label(desc);
            }
            for f in &embed.fields {
                ui.horizontal(|ui| {
                    ui.strong(format!("{}:", f.name));
                    ui.label(&f.value);
                });
            }
        });
}
