# MCP ダッシュボード プロキシ アーキテクチャ

## 概要

MCP サーバー（例: ywrk-mcp）のダッシュボードを yuuka の管理画面に**同一オリジンの iframe(srcdoc) 埋め込み**で表示する際、
**ユーザーがトークンを手入力しなくても自動的に認証済み状態で起動する**仕組みです。

ダッシュボードの実体は MCP サーバー側の SPA（単一 HTML）ですが、その JS が必要とする Bearer トークンと
API エンドポイントを、yuuka がサーバー側で解決・中継します。ブラウザ（クライアント）には実 YWRK_TOKEN を渡しません。

> **埋め込み方式について（重要）**: 当初は SPA HTML を `#mcp-dashboard-container` へ直接 DOM 注入していたが、
> SPA が読み込む外部 CSS（akizakura.css 等）や `html,body{...}` ルールが **yuuka 本体のドキュメント全体に波及して
> 管理画面のスタイルを破壊する**問題があったため、CSS/JS を隔離できる **iframe(srcdoc)** 方式へ変更した。
> iframe は `sandbox="allow-scripts allow-same-origin allow-forms"` とし、同一オリジン扱いを保つことで
> `/proxy/mcp` への fetch・Cookie セッション・proxyToken がそのまま機能する。

---

## コンポーネント構成

```
[ブラウザ]
  │  yuuka セッション Cookie
  ▼
[yuuka (Node.js)]
  ├─ GET  /api/mcp-servers/:id/dashboard   ← HTML 取得・書き換え（auth: user）
  └─ POST /proxy/mcp/:id/mcp               ← MCP API プロキシ（auth: user + Bearer 注入）
       │  Authorization: Bearer <YWRK_TOKEN>  ← DB から復号
       ▼
[ywrk-mcp (Rust)]
  ├─ GET  /dashboard   ← SPA HTML を返す（無認証配信・frame-ancestors 'none'）
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

   ※ `<proxyToken>` は 256-bit 乱数（hex）の短命トークン（有効期限1時間）。
   ※ `location.hash` は使わない（親ページの URL を汚染するため）。
   ※ **書き換え検証**: 各 `String.replace` は不一致時に元文字列をそのまま返すため、`MCP_PATH` と
     `tokenFromHash` の置換が実際に起きたかを検証し、別リポジトリ(ywrk-mcp/dashboard.html)の
     フォーマットがドリフトした場合は **壊れたページを 200 で返さず 502 で失敗させる**（サイレント破損防止）。

3. フロントエンドが返却 HTML を `injectMcpDashboardHtml()` で iframe(srcdoc) として
   `#mcp-dashboard-container` に埋め込む

4. iframe 内で SPA が起動すると:
   - `<head>` 内の `<script>` が先に実行 → `window.__mcpProxyToken__` にトークンをセット（iframe の window）
   - SPA の `boot()` が書き換え後の `tokenFromHash()` でトークンを取得
   - トークンが非 null → トークン入力フォーム（token-gate）は表示されず、即座にデータ取得へ進む

---

## iframe(srcdoc) 埋め込みの仕組み（`injectMcpDashboardHtml`）

```
1. <iframe sandbox="allow-scripts allow-same-origin allow-forms"> を生成
2. iframe.srcdoc = <書き換え後HTML>   （srcdoc なのでブラウザがスクリプトを通常実行する）
3. container へ append
4. SPA が postMessage({type:"ywrk-dashboard:resize", height}) を送るので
   iframe.style.height を追従させる（高さ自動調整）
```

- `allow-same-origin` により iframe は yuuka と同一オリジン扱い → `/proxy/mcp` への fetch は同一オリジン、
  Cookie セッションも届く、CSP の `'self'` も yuuka オリジンに解決される。
- `allow-scripts` 単独だと不透明オリジンになり、`connect-src 'self'` が `/proxy/mcp` に一致せず fetch がブロックされるため、
  `allow-same-origin` は必須。
- モーダルを閉じる際は `teardownMcpDashboard()` で iframe を破棄し、リサイズ用の `message` リスナーも
  `removeEventListener` する（リスナー蓄積の防止）。iframe 破棄により SPA が登録した window スコープの
  リスナーも一緒に消える。

---

## CSP（Content-Security-Policy）の注意 ⚠️

iframe(srcdoc) は親（yuuka）の CSP を**継承**する。`allow-same-origin` のため `'self'` は yuuka オリジンに解決される。
したがって SPA が読み込む外部リソースは引き続き yuuka の CSP（`src/server.ts` の `CSP` 定数）に従う:

- `style-src` に `https://akizakura.pages.dev`（ywrk ダッシュボードの design system）が必要。
  許可していないと CSP にブロックされ、ダッシュボードが無スタイルで崩れる
  （`.container`/`.stack`/`.cluster` 等のレイアウトクラスと `--space-*` 変数が失われる）。→ 追加済み。
- `style-src`/`font-src` に Google Fonts（`fonts.googleapis.com`/`fonts.gstatic.com`）も必要。→ 追加済み。
- `connect-src 'self'` で `/proxy/mcp/<id>/mcp` への fetch を許可（同一オリジン）。

> **重要**: iframe 化により SPA の `<style>`/`<link>`（`html,body{background:transparent}` や akizakura.css 等）は
> **iframe ドキュメント内に隔離される**ため、以前のように yuuka 本体のスタイルを破壊することはない。
> ただし CSP は親から継承するため、SPA が読む外部オリジンの許可は引き続き必要。
>
> 別の MCP サーバーのダッシュボードが別オリジンの CSS/フォント/画像を読む場合は、その都度
> 対応する CSP ディレクティブ（`style-src` / `font-src` / `img-src` / `connect-src`）の許可が必要。

---

## MCP API プロキシの仕組み（`POST /proxy/mcp/:id/mcp`）

SPA の JS が `fetch("/proxy/mcp/<id>/mcp", { headers: { Authorization: "Bearer <proxyToken>" } })` を呼ぶ。
iframe は同一オリジンのため CORS は発生せず、追加の CORS ヘッダー／OPTIONS プリフライトは不要（撤去済み）。

このルートは **`auth: "user"`（Cookie セッション必須）** であり、以下を多層で検証する:

1. **proxyToken**: サーバー内メモリの `proxyTokens` Map で `serverId` 一致と有効期限を確認
2. **発行ユーザー照合**: トークン発行時の `userId` と、現在の Cookie セッションユーザーが一致すること
   （トークン漏洩時のなりすまし中継を防ぐ）
3. **canManage / enabled の再検証**: 発行後に権限（降格）やサーバーの有効状態（無効化）が
   変化していないかを毎回再チェック
4. DB から暗号化された `YWRK_TOKEN` を取得し AES-GCM で復号
5. 復号した本物 Bearer トークンを付与して ywrk-mcp の `/mcp` へ POST をそのまま転送
6. ywrk-mcp のレスポンス（JSON または SSE）をブラウザへストリーミングで返す

```
Browser (iframe内SPA)             yuuka                     ywrk-mcp
  POST /proxy/mcp/1/mcp   →   セッション + proxyToken
  Authorization: Bearer        + userId + canManage + enabled
  <proxyToken>             →   復号(YWRK_TOKEN)
                               POST /mcp                  →  Bearer <real>
                           ←   SSE / JSON (streaming)     ←
```

なお、サーバーを**無効化・削除**すると、発行済み proxyToken は即時失効する
（`revokeProxyTokensForServer`）。開きっぱなしのダッシュボードが無効化後に中継し続けるのを防ぐ。

---

## セキュリティ設計

| 観点 | 対策 |
|---|---|
| 実 YWRK_TOKEN をブラウザに渡さない | 使い捨てではない短命プロキシトークンを使用。実 token は yuuka サーバー内でのみ復号 |
| セッションなしで proxy 呼べない | プロキシルートは `auth: "user"`。Cookie セッション必須 |
| 他ユーザーの MCP サーバーを操作できない | proxyToken は `{serverId, userId}` に紐付け、**中継時に userId とセッションユーザーを照合**し、`canManage` も再検証 |
| 発行後の権限・状態変化 | 中継のたびに `canManage`（降格）と `enabled`（無効化）を再検証。無効化/削除でトークン即時失効 |
| 埋め込み SPA の DOM/スタイル隔離 | iframe(srcdoc) により SPA の CSS/JS を隔離。`sandbox` で権限を最小化（allow-scripts/same-origin/forms のみ） |
| SSE/長期接続のリソースリーク | `res.on("close")` で `AbortController` をキャンセル（`req` はボディ読了後に発火しないため `res` を使う） |
| 上流ストリームの途中エラー | reader ループでエラーを握り潰さず、レスポンスを異常終了させて「200 + 切り詰めボディ」を返さない |

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/server/routes/mcpRoutes.ts` | `/api/mcp-servers/:id/dashboard`（HTML書き換え・トークン発行・書換検証）・`/proxy/mcp/:id/mcp`（プロキシ・多層認証・トークン失効）|
| `src/server.ts` | CSP 定数（`style-src` の akizakura 許可等）|
| `src/services/mcpClient.ts` | `buildAuthHeader()`（Bearer ヘッダー構築）・`fetchMcpDashboardHtml()`（upstream fetch）|
| `src/public/app.js` | `injectMcpDashboardHtml()`（iframe srcdoc 埋め込み）・`openMcpDashboard()`（取得・表示）・`teardownMcpDashboard()`（破棄）|
| `src/public/index.html` | `<div id="mcp-dashboard-container">` の定義 |
| `ywrk-mcp/src/main.rs` | `/dashboard`（`frame-ancestors 'none'`）・`/dashboard/enable`（無効時 404）|
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
   │               │ iframe(srcdoc)で埋め込み・SPA 起動    │
   │               │ window.__mcpProxyToken__ からtoken取得│
   │               │                 │                    │
   │               │ POST /proxy/mcp/:id/mcp（同一オリジン）│
   │               │ Cookie + Bearer: <proxyToken>        │
   │               │────────────────▶│ userId/canManage/  │
   │               │                 │ enabled 再検証      │
   │               │                 │ POST /mcp          │
   │               │                 │ Bearer: <real>     │
   │               │                 │───────────────────▶│
   │               │                 │◀─── SSE/JSON ─────│
   │               │◀── stream ──────│                    │
   │◀─ データ表示 ─│                 │                    │
```
