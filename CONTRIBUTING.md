# コントリビューションガイド

Yuuka への貢献ありがとうございます。このドキュメントは開発フローと最低限のルールをまとめた単一の参照点です。詳細なセットアップ・仕様は [`docs/index.md`](docs/index.md) を参照してください。

## 開発環境

- **Node.js** >= 20
- **pnpm**（パッケージマネージャ）
- **Rust / cargo**（`rust_crawler` / `rust_synapse` のビルドに必要。`pnpm build` 実行時のみ）

```bash
pnpm install        # 依存関係のインストール
pnpm dev            # tsx watch で開発起動
```

設定（環境変数・config.yaml 等）の準備は [`docs/guide/setup.md`](docs/guide/setup.md) を参照してください。

## ブランチ運用

- `main` … リリース（本番相当）。直接 push せず PR 経由のみ。
- `develop` … 統合ブランチ。**機能・修正の PR は原則ここへ向けて作成します。**
- 作業ブランチ … `develop` から切り、用途に応じた接頭辞を付けます。
  - `feat/...` 新機能
  - `fix/...` バグ修正
  - `refactor/...` 挙動を変えないリファクタ
  - `docs/...` ドキュメント
  - `chore/...` / `ci/...` 雑務・CI

リリース時のみ `develop → main` の PR をマージします。

```bash
git switch develop && git pull
git switch -c fix/something develop
# ... 変更 ...
```

## コミット前のチェック（必須）

PR を出す前に、ローカルで以下が通ることを確認してください。

```bash
pnpm check          # = pnpm typecheck && pnpm lint
```

- `pnpm typecheck` … `tsgo --noEmit`（型エラー 0）
- `pnpm lint` … `biome check src/`
- `pnpm format` … `biome format --write src/`（整形のみ）
- `pnpm lint:fix` … 自動修正可能な lint の一括適用

> CI（`.github/workflows/ci.yml`）でも PR / push 時に typecheck・lint が実行されます。

### コミットメッセージ

[Conventional Commits](https://www.conventionalcommits.org/) 風（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `ci:`）を推奨します。関連 issue は本文で `Closes #123` のように紐付けてください。

## Pull Request

1. `develop` をベースに PR を作成します（テンプレートが自動挿入されます）。
2. テンプレートの **変更概要 / テスト / デプロイ影響** を埋めてください。
3. `pnpm check` が green であること、秘密情報を含めていないことを確認します。
4. レビュー後に squash / merge します。

## ビルドとデプロイ

```bash
pnpm build          # Rust バイナリ + tsgo（dist/ を生成）
pnpm start          # node dist/index.js

# Docker による本番 / 開発インスタンス運用（詳細は docs/guide/deployment.md）
pnpm deploy         # prod を更新
pnpm deploy:dev     # dev を更新
pnpm deploy:rollback
```

Dockerfile を変更した場合はキャッシュ無効のフルビルド（`--no-cache`）と再起動が必要です。

## セキュリティ

脆弱性は公開 issue ではなく、[セキュリティアドバイザリ](https://github.com/Suki-9/yuuka/security/advisories/new) で非公開に報告してください。トークン・APIキー・個人情報をコミットやログ、issue/PR に含めないでください。
