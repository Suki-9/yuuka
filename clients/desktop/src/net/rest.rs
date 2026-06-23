//! REST ヘルパ（reqwest + Bearer）。
//!
//! 仕様: backend_api.md §1.5（Bearer 認証）/ §4（端末管理）/ client_design.md §9。
//! 現状の利用箇所は `GET /api/bots`（Bot 一覧・オーブ画像取得）と
//! `GET /api/devices`（端末一覧）。トークン失効（ログアウト）は
//! `POST /api/devices/revoke`（自端末）を使う。

use serde::Deserialize;

use crate::config::rest_base;
use crate::model::BotInfo;

/// REST 呼び出しのエラー。
#[derive(Debug, thiserror::Error)]
pub enum RestError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    /// 401: トークン失効。呼び出し側は保存トークンを破棄して再ログインへ。
    #[error("unauthorized (token invalid/expired)")]
    Unauthorized,
}

/// `GET /api/devices` の 1 要素（backend_api.md §4）。
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// この端末自身か。
    #[serde(default)]
    pub current: Option<bool>,
}

/// Bearer 付きの `reqwest::RequestBuilder` を作る共通ヘルパ。
fn bearer(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    req.bearer_auth(token)
}

/// 401 を [`RestError::Unauthorized`] に正規化してから JSON を読む。
async fn json_or_unauthorized<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, RestError> {
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(RestError::Unauthorized);
    }
    Ok(resp.error_for_status()?.json().await?)
}

/// `GET /api/bots` — 所有/共有 Bot の一覧。
///
/// オーブ画像（`discord_avatar_url`）と切替セレクタに使う。WS の `ready.bots`
/// と同型（[`BotInfo`]）。
pub async fn get_bots(client: &reqwest::Client, token: &str) -> Result<Vec<BotInfo>, RestError> {
    let resp = bearer(client.get(format!("{}/api/bots", rest_base())), token)
        .send()
        .await?;
    json_or_unauthorized(resp).await
}

/// `GET /api/devices` — 端末一覧（端末管理・自端末判定）。
pub async fn get_devices(
    client: &reqwest::Client,
    token: &str,
) -> Result<Vec<DeviceInfo>, RestError> {
    let resp = bearer(client.get(format!("{}/api/devices", rest_base())), token)
        .send()
        .await?;
    json_or_unauthorized(resp).await
}

/// `POST /api/devices/revoke` — 自端末トークンの失効（ログアウト時。client_design.md §8）。
pub async fn revoke_device(
    client: &reqwest::Client,
    token: &str,
    device_id: &str,
) -> Result<(), RestError> {
    let resp = bearer(
        client.post(format!("{}/api/devices/revoke", rest_base())),
        token,
    )
    .json(&serde_json::json!({ "id": device_id }))
    .send()
    .await?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(RestError::Unauthorized);
    }
    resp.error_for_status()?;
    Ok(())
}
