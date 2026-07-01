#!/bin/sh
set -e

# node_modules が未セットアップ（または package.json より古い）なら自動インストール
if [ ! -f node_modules/.modules.yaml ] || [ package.json -nt node_modules/.modules.yaml ]; then
  echo "📦 node_modules をセットアップ中..."
  pnpm install --frozen-lockfile
fi

exec pnpm run dev
