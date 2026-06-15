# MCP ダッシュボード プロキシ アーキテクチャ

## 概要

MCP サーバー（例: ywrk-mcp）のダッシュボードを yuuka の管理画面に**動的埋め込み**で表示する際、  
**ユーザーがトークンを手入力しなくても自動的に認証済み状態で起動する**仕組みです。

ダッシュボードの実体は MCP サーバー側の SPA（単一 HTML）ですが、その JS が必要とする Bearer トークンと  
API エンドポイントを、yuuka がサーバー側で解決・中継します。ブラウザ（クライアント）には実 YWRK_TOKEN を渡しません。

---

## コンポーネント構成

```
[ブラウザ]
  │  yuuka セッション Cookie
  ▼
[yuuka (Node.js)]
  ├─ GET  /api/mcp-servers/:id/dashboard   ← HTML 取得・書き換え
  └─ POST /proxy/mcp/:id/mcp              ← MCP API プロキシ（Bearer 注入）
       │  Authorization: Bearer <YWRK_TOKEN>  ← DB から復号
       ▼
[ywrk-mcp (Rust)]
  ├─ GET  /dashboard   ← SPA HTML を返す（認証不要）
  └─ POST /mcp         ← MCP JSON-RPC（Bearer 認証必須）
```

---

## トークン自動注入の仕組み（`GET /api/mcp-servers/:id/dashboard`）

1. yuuka サーバーが ywrk-mcp の `/dashboard` を Bearer 認証付きで取得（HTML）
2. 取得した HTML に対して以下の書き換えを実施してからフロントエンドへ返す:

   | 書き換え対象 | 変更前 | 変更後 |
   |---|---|---|
   | `var MCP_PATH` | `"/mcp"` | `"/proxy/mcp/<id>/mcp"` |
   | SPA の `tokenFromHash()` 関数 | `location.hash` からトークンを読む | `window.__mcpProxyToken__` を返す |
   | `<head>` 直後 | — | `<script>window.__mcpProxyToken__ = "<proxyToken>";</script>` |

   ※ `<proxyToken>` は 256-bit 乱数（hex）の使い捨てトークン（有効期限1時間）。  
   ※ `location.hash` は使わない（親ページの URL を汚染するため）。

3. フロントエンドが返却 HTML を `injectMcpDashboardHtml()` で `#mcp-dashboard-container` に直接挿入

4. 埋め込まれた SPA が起動すると:
   - `<head>` 内の `<script>` が先に実行 → `window.__mcpProxyToken__` にトークンをセット
   - SPA の `boot()` が書き換え後の `tokenFromHash()` でトークンを取得
   - トークンが非 null → トークン入力フォーム（token-gate）は表示されず、即座にデータ取得へ進む

---

## 動的埋め込みの仕組み（`injectMcpDashboardHtml`）

`innerHTML` による HTML 挿入では `<script>` は実行されないため、手動で再生成する。

```
1. DOMParser で HTML 文字列をパース
2. <script> 要素を先に全抽出・除去
3. <head>/<body> の残りノードを importNode() で container に移植
4. 抽出した script を createElement("script") で再生成し順序通り追加
   → ブラウザが script を同期実行
```

モーダルを閉じる際は `container.innerHTML = ""` と `delete window.__mcpProxyToken__` でクリーンアップ。

---

## MCP API プロキシの仕組み（`POST /proxy/mcp/:id/mcp`）

SPA の JS が `fetch("/proxy/mcp/<id>/mcp", { headers: { Authorization: "Bearer <proxyToken>" } })` を呼ぶ。

> **注意**: 動的埋め込みの fetch は yuuka オリジン上で実行されるため CORS は問題にならないが、
> CORS プリフライト（OPTIONS）は念のため `/proxy/mcp/` プレフィックスで許可している（`server.ts`）。

1. yuuka がリクエストヘッダーの `Authorization: Bearer <proxyToken>` を検証  
   （サーバー内メモリの `proxyTokens` Map で serverId と有効期限を確認）
2. DB から暗号化された `YWRK_TOKEN` を取得し AES-GCM で復号
3. 復号した本物 Bearer トークンを付与して ywrk-mcp の `/mcp` へ POST をそのまま転送
4. ywrk-mcp のレスポンス（JSON または SSE）をブラウザへストリーミングで返す

```
Browser (div内SPA)                yuuka                     ywrk-mcp
  POST /proxy/mcp/1/mcp   →   認証(proxyToken検証)
  Authorization: Bearer        復号(YWRK_TOKEN)
  <proxyToken>             →   POST /mcp                  →  Bearer <real>
                           ←   SSE / JSON (streaming)     ←
```

---

## セキュリティ設計

| 観点 | 対策 |
|---|---|
| 実 YWRK_TOKEN をブラウザに渡さない | 使い捨てプロキシトークンを使用。実 token は yuuka サーバー内でのみ復号 |
| セッションなしで proxy 呼べない | プロキシトークンはダッシュボード発行（Cookie 認証済み）時にのみ生成。1時間で失効 |
| 他ユーザーの MCP サーバーを操作できない | トークンは `{serverId, userId}` に紐付け。別サーバー ID では無効 |
| 埋め込み SPA の DOM スコープ | 動的埋め込みのため yuuka の DOM にアクセス可能。将来的に検査・サニタイズを追加予定 |
| SSE/長期接続のリソースリーク | `req.on("close")` で AbortController をキャンセル |

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/server/routes/mcpRoutes.ts` | `/api/mcp-servers/:id/dashboard`（HTML書き換え・トークン発行）・`/proxy/mcp/:id/mcp`（プロキシ）|
| `src/server.ts` | `/proxy/mcp/` への CORS プリフライト（OPTIONS）処理 |
| `src/services/mcpClient.ts` | `buildAuthHeader()`（Bearer ヘッダー構築）・`fetchMcpDashboardHtml()`（upstream fetch）|
| `src/public/app.js` | `injectMcpDashboardHtml()`（DOM注入）・`openMcpDashboard()`（取得・表示） |
| `src/public/index.html` | `<div id="mcp-dashboard-container">` の定義 |
| `ywrk-mcp/src/dashboard.html` | SPA 本体。`tokenFromHash()` をサーバー側で書き換えて `window.__mcpProxyToken__` を参照させる |

---

## シーケンス図

```
ユーザー        ブラウザ           yuuka              ywrk-mcp
   │               │                 │                    │
   │ 管理ページ開く │                 │                    │
   │──────────────▶│                 │                    │
   │               │ GET /api/mcp-servers/:id/dashboard   │
   │               │────────────────▶│                    │
   │               │                 │ GET /dashboard     │
   │               │                 │───────────────────▶│
   │               │                 │◀─── HTML ─────────│
   │               │                 │ MCP_PATH 書き換え  │
   │               │                 │ tokenFromHash 書換 │
   │               │                 │ proxyToken 注入    │
   │               │◀── {html:...} ──│                    │
   │               │ DOM に直接注入  │                    │
   │               │ SPA 起動        │                    │
   │               │ window.__mcpProxyToken__ からtoken取得│
   │               │                 │                    │
   │               │ POST /proxy/mcp/:id/mcp              │
   │               │ Bearer: <proxyToken>                 │
   │               │────────────────▶│                    │
   │               │                 │ POST /mcp          │
   │               │                 │ Bearer: <real>     │
   │               │                 │───────────────────▶│
   │               │                 │◀─── SSE ──────────│
   │               │◀── SSE stream ──│                    │
   │◀─ データ表示 ─│                 │                    │
```
