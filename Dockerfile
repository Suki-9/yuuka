# syntax=docker/dockerfile:1
# ==============================================================================
# Yuuka - マルチステージ Docker ビルド
#   stage 1 (rust-builder) : Rust 製クローラ yuuka-crawler をビルド
#   stage 2 (node-builder) : 依存導入 + TypeScript(tsgo) ビルド -> dist/
#   stage 3 (runtime)      : 本番実行イメージ（system chromium 同梱）
# 同一イメージを本番(prod)・開発(dev)など複数インスタンスで使い回す。
# インスタンス固有の差分（ポート/データ/シークレット/設定）は docker-compose 側で注入。
# ==============================================================================

# ---- stage 1: Rust crawler + synapse engine ----------------------------------
FROM rust:1-bookworm AS rust-builder
# クローラ（browser 不変層）
WORKDIR /build/crawler
COPY src/rust_crawler/Cargo.toml src/rust_crawler/Cargo.lock ./
COPY src/rust_crawler/src ./src
RUN cargo build --release \
 && cp target/release/yuuka-crawler /yuuka-crawler
# シナプスエンジン（schema v10 / 一新案 v3。記憶の重い処理を V8 ヒープ外へ）
WORKDIR /build/synapse
COPY src/rust_synapse/Cargo.toml src/rust_synapse/Cargo.lock ./
COPY src/rust_synapse/src ./src
RUN cargo build --release \
 && cp target/release/yuuka-synapse /yuuka-synapse

# ---- stage 2: Node / TypeScript build ---------------------------------------
FROM node:24-bookworm AS node-builder
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
# ホスト/ロックファイルと同じ pnpm 9 系を使用（pnpm 11 は package.json の pnpm.overrides を
# 読まず lockfile と不一致になるため固定する）
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
# better-sqlite3 等のネイティブモジュールをビルドするためのツールチェーン
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# 依存導入（ロックファイル厳守）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# ソース・ドキュメントを取り込み TypeScript をビルド
COPY tsconfig.json ./
COPY src ./src
COPY docs ./docs
RUN pnpm exec tsgo \
 && mkdir -p dist/bin dist/assets \
 && cp -r src/assets/. dist/assets/
# Rust バイナリを dist/bin へ配置（browserService / synapseEngine が参照）
COPY --from=rust-builder /yuuka-crawler dist/bin/yuuka-crawler
COPY --from=rust-builder /yuuka-synapse dist/bin/yuuka-synapse
# 本番依存だけに刈り込み（tsx / biome / typescript 等の devDeps を除去）
RUN pnpm prune --prod

# ---- stage 3: runtime --------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
# TZ=Asia/Tokyo: アプリは SQLite の datetime('now','localtime') や new Date()/getHours() など
# プロセスのローカルTZに依存して時刻を扱う（JST前提）。Debian slim は既定 UTC のため、
# 未設定だと全時刻が9時間ずれる。tzdata（下の apt-get）と併せて JST に固定する。
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
# Puppeteer 用 system chromium + 日本語/絵文字フォント + crawler(reqwest) の TLS 依存 + tzdata(JST解決用)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates libssl3 \
      tzdata \
 && rm -rf /var/lib/apt/lists/*
# アプリ本体（runtime に必要なものだけ builder から取得）
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/dist ./dist
COPY --from=node-builder /app/src/public ./src/public
COPY --from=node-builder /app/src/assets ./src/assets
COPY --from=node-builder /app/docs ./docs
COPY package.json ./
# data/ は外部マウント、scratch/ はバックアップ一時作業用。node ユーザ(uid 1000)で書込可能に。
RUN mkdir -p /app/data /app/scratch && chown -R node:node /app
USER node
EXPOSE 7854
CMD ["node", "dist/index.js"]
