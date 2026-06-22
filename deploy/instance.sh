#!/usr/bin/env bash
# ==============================================================================
# Yuuka インスタンス操作ヘルパー
#   使い方: deploy/instance.sh <インスタンス名> <docker compose のサブコマンド...>
#   例:
#     deploy/instance.sh prod up -d        # 本番を起動
#     deploy/instance.sh dev  up -d         # 開発を起動
#     deploy/instance.sh prod logs -f       # ログ追従
#     deploy/instance.sh dev  down          # 停止・撤去
#     deploy/instance.sh prod build         # イメージビルド
#     deploy/instance.sh prod ps            # 状態確認
#
# 動作:
#   - deploy/<name>/instance.env を読み込み（COMPOSE_PROJECT_NAME, ポート, パス等）
#   - deploy/<name>/secret.key を YUUKA_ENCRYPTION_SECRET として literal で export
#   - 必要なら deploy/<name>/secret.key.new を YUUKA_ENCRYPTION_SECRET_NEW として export
#     （暗号化シークレットのローテーション時のみ。完了後は new を削除して再起動）
# ==============================================================================
set -euo pipefail

INST="${1:-}"
if [ -z "$INST" ]; then
  echo "usage: $0 <instance> <docker compose subcommand...>" >&2
  echo "  instances: $(cd "$(dirname "${BASH_SOURCE[0]}")" && ls -d */ 2>/dev/null | tr -d / | tr '\n' ' ')" >&2
  exit 1
fi
shift

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INST_DIR="$ROOT/deploy/$INST"
ENV_FILE="$INST_DIR/instance.env"
SECRET_FILE="$INST_DIR/secret.key"

[ -f "$ENV_FILE" ]    || { echo "❌ インスタンス設定が見つかりません: $ENV_FILE" >&2; exit 1; }
[ -f "$SECRET_FILE" ] || { echo "❌ シークレットが見つかりません: $SECRET_FILE" >&2; exit 1; }

# instance.env を export（$ を含まない安全な値のみ。compose 変数展開にも使う）
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# 暗号化シークレットは $(cat) で literal 取得（ファイル内の $ は再展開されない）
YUUKA_ENCRYPTION_SECRET="$(cat "$SECRET_FILE")"
export YUUKA_ENCRYPTION_SECRET

# ローテーション用の新キー（存在すれば）
if [ -f "$INST_DIR/secret.key.new" ]; then
  YUUKA_ENCRYPTION_SECRET_NEW="$(cat "$INST_DIR/secret.key.new")"
  export YUUKA_ENCRYPTION_SECRET_NEW
fi

exec docker compose \
  -p "$COMPOSE_PROJECT_NAME" \
  --env-file "$ENV_FILE" \
  -f "$ROOT/docker-compose.yml" \
  "$@"
