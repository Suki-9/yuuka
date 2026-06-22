# Yuuka ドキュメント インデックス

『Yuuka』（Discord Gemini 秘書ボット & Web 管理ダッシュボード）の設計・仕様・運用ドキュメントの目次です。
人間向けの導入・セットアップは [../README.md](../README.md) を参照してください。

---

## 📂 ディレクトリ構成

```
docs/
├── index.md                 ← このファイル（目次）
├── project_overview.md      ← AI/開発者向けの全体像・モジュールマップ
├── architecture/            ← 実装規範・設計（最優先で従う）
│   └── architecture_v2.md
├── spec/                    ← 機能仕様・要件
│   ├── discordbot_spec.md
│   └── bot_attributes_requirements.md
├── skills/                  ← LLM 実行時に注入されるスキル仕様
│   └── search_skills.md
└── design/                  ← 将来構想の設計方針（提案 / 未実装）
    ├── synapse_cognitive_architecture.md   ← 設計思想・研究裏付け
    └── architecture_renewal_v3.md          ← 全体アーキテクチャ一新案（Rustエンジン/トポロジ）
```

---

## 📖 目的別の入口

| 知りたいこと | 読む文書 |
|---|---|
| プロジェクト全体像・どのファイルを触ればよいか | [project_overview.md](project_overview.md) |
| 実装の規範・不変条件・DB スキーマ・ファイル所有マップ | [architecture/architecture_v2.md](architecture/architecture_v2.md) |
| 各機能の詳細仕様（ToDo・家計・ブラウザ操作 等） | [spec/discordbot_spec.md](spec/discordbot_spec.md) |
| Bot の動作モード（秘書 / MCP アシスタント）・能力 | [spec/bot_attributes_requirements.md](spec/bot_attributes_requirements.md) |
| 検索クロール時の LLM 指示（天気・運行・ニュース） | [skills/search_skills.md](skills/search_skills.md) |

---

## 📚 文書一覧と権威順序

矛盾した場合は **上にある文書が優先**します。

### 1. [architecture/architecture_v2.md](architecture/architecture_v2.md) — 実装規範（最優先）
仕様を既存コードへ落とし込むための実装コントラクト。**§0 の不変条件（do-not-change）**、§1 共有型、§2 DB スキーマ、§3 暗号、§10 ファイル所有マップを定義。仕様書と矛盾する場合は本書が優先。

### 2. [spec/bot_attributes_requirements.md](spec/bot_attributes_requirements.md) — Bot 属性拡張要件
Bot の動作モード（**secretary 秘書 / mcp_assistant 汎用**）の能力プリセット、2 層メモリ、汎用モードの分離スコープ（`bot_id × user_id` / `bot_id × guild_id`）を規定。architecture_v2 を Bot モード向けに精緻化。

### 3. [spec/discordbot_spec.md](spec/discordbot_spec.md) — マスター機能仕様（v0.6.2）
全機能の要件定義。§3 Bot 機能（対話・タスク・リマインド・家計・ブラウザ・マクロ・メモリ・日報・連絡先・会話ログ要約・Webhook・音声）、§4 ペルソナ/API/MCP、§5 ユーザー/Bot 管理、§6 PW マネージャ、§7 会話履歴、§8 バックアップ、§9 外部連携、§10 非機能要件。

### 4. [skills/search_skills.md](skills/search_skills.md) — 検索クロールスキル
LLM が `searchWeb` / `fetchDynamicPage` を使う際の推奨ドメイン・クエリ・巡回フロー（天気=気象庁優先、運行=Yahoo、ニュース=一次ソース）。
**⚠️ このファイルは [../src/gemini.ts](../src/gemini.ts) が実行時に読み込みシステムプロンプトへインライン注入します。移動・改名する場合は `loadSearchSkills()` の候補パスも更新すること。**

### （横断）[project_overview.md](project_overview.md) — AI オンボーディングガイド
リポジトリ全体のアーキテクチャ図・ディレクトリ/モジュールマップ・主要ランタイムフロー・不変条件・コーディング規約を 1 枚に集約。新規参加者（人間・AI）の最初の入口。

---

## 🧪 提案・将来構想（未実装 / 権威順序の外）

実装規範ではなく、まだ確定していない設計方針。現行コードへの拘束力はない（着手時に architecture へ昇格）。

- [design/synapse_cognitive_architecture.md](design/synapse_cognitive_architecture.md) — **シナプス駆動 認知アーキテクチャ設計方針書**（思想・研究裏付け）。軽量LLMの思考補助を「生履歴注入」から「データ層へ外付けしたシナプス記憶＋2-Hop連想」へ刷新する提案。ハイブリッドLLM構成（重い推論=Gemini / 前処理=ローカル軽量LLM）、記憶エンジン比較（SQLite+sqlite-vec vs DuckDB）、構造化出力の推論劣化回避＋ペルソナ両立、投機的実行、評価指標、段階導入ロードマップを研究裏付け付きで記述。
- [design/architecture_renewal_v3.md](design/architecture_renewal_v3.md) — **全体アーキテクチャ一新案（v3 提案）**（システム実装面）。シナプス関連を **Rust の独立プロセス**（埋め込み/USearch索引/2-Hop/勝率集計）として切り出し、Node(V8)のメモリトラブルを回避する 3 プロセス構成（Node / Rustシナプスエンジン / ローカルSLM）。プロセストポロジ・制御フロー・Rustエンジン設計・メモリ安全設計・データ所有/不変条件保全・Stranglerパターンの段階移行を記述。
