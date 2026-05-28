# Yuuka - Discord Gemini Secretary Bot & Admin Dashboard

---

## 🚀 セットアップ手順

### 1. リポジトリのクローンと依存関係のインストール

プロジェクトディレクトリに移動し、依存パッケージをインストールします。

```bash
pnpm install
```

### 2. 設定ファイルの作成

テンプレートファイル `example.yaml` をコピーして、`config.yaml` を作成します。

```bash
cp example.yaml config.yaml
```

`config.yaml` を開き、以下の必要な認証情報・トークンを設定してください。

#### 主な設定項目:
*   **`DISCORD_TOKEN`**: [Discord Developer Portal](https://discord.com/developers/applications) で取得したBotトークン。
*   **`GEMINI_API_KEY`**: [Google AI Studio](https://aistudio.google.com/apikey) で発行したAPIキー。
*   **`GUILD_ID`**: 動作させるDiscordサーバーのID。
*   **`GOOGLE_CALENDARS`**: 同期させたいGoogleカレンダーIDの配列（管理画面からも動的に追加・削除可能です）。
*   **`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY`**: Google Cloud Console で作成したサービスアカウントのメールアドレスと秘密鍵（Googleカレンダー連携に必要）。
*   **`ADMIN_TOKEN`**: 管理画面ダッシュボードにログインするための任意のセキュアなパスコード。

---

## 🏃 起動と開発

### 開発モード (ホットリロード有効)
コードの変更を監視し、自動でサーバーが再起動します。

```bash
pnpm dev
```

### プロダクションビルド & 起動
TypeScript のコンパイルを行い、本番環境用として最適化されたビルドを起動します。

```bash
# コンパイル (dist/ 以下に出力されます)
pnpm build

# 本番サーバーの起動
pnpm start
```

起動後、ブラウザで `http://localhost:7854` (または `config.yaml` で設定したポート/ホスト) にアクセスすると、管理者用ダッシュボードが開きます。設定した `ADMIN_TOKEN` を入力してログインしてください。

---

## ⚙️ systemd による常時稼働 (Linux環境)

同梱されている `yuuka.service` テンプレートを利用して、Linuxサーバー上でサービスとしてデーモン化できます。

1.  `yuuka.service` ファイルをお使いの環境のパス (例: `WorkingDirectory` や `ExecStart` のNode.jsパスなど) に合わせて編集します。
2.  サービスファイルを配置します：
    ```bash
    sudo cp yuuka.service /etc/systemd/system/yuuka.service
    ```
3.  デーモンをリロードしてサービスを有効化・起動します：
    ```bash
    sudo systemctl daemon-reload
    sudo systemctl enable yuuka.service
    sudo systemctl start yuuka.service
    ```
4.  ステータスの確認：
    ```bash
    sudo systemctl status yuuka.service
    ```
