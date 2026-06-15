# Yuuka プロジェクト AI オンボーディングガイド

> このファイル（`docs/project_overview.md`）は **AI コーディングエージェント（Claude Code 等）がリポジトリ全体を素早く正確に把握する**ための地図です。
> 仕様の根拠・詳細は [docs/](../docs/) の各文書に委ねます（重複させず、ポインタを張ります）。
> 人間向けの導入・セットアップは [README.md](../README.md) を参照。

---

## 1. これは何か（30秒サマリ）

**Yuuka** は Google **Gemini API** を使った **Discord 秘書ボット** と **Web 管理ダッシュボード** を 1 プロセスで統合運用するソフトウェアです。

- 1 つの Node.js プロセスが「Discord Bot ランタイム」「LLM 対話エンジン」「HTTP 管理サーバ」「多数のバックグラウンド常駐ジョブ」を同時に動かす。
- LLM は **Function Calling** で約 70 種のツール（ToDo・家計・予定・リマインド・ブラウザ操作・パスワードマネージャ・MCP 等）を呼び出して秘書業務を遂行する。
- 全ユーザーデータは **Discord ユーザー ID 単位で完全分離**。これは設計の最重要不変条件（§8 参照）。
- Bot は 2 つの動作モードを持つ: **秘書モード（secretary）**＝個人 DM 中心・ユーザー自身の Gemini 鍵、**汎用モード（MCP アシスタント）**＝ギルド常駐・Bot 専用 Gemini 鍵。

---

## 2. 技術スタック / クイックファクト

| 項目 | 値 |
|---|---|
| 言語 / 実行系 | TypeScript（**ESM**, `"type": "module"`）/ **Node.js 20+** |
| パッケージ管理 | **pnpm**（`pnpm-workspace.yaml` あり） |
| DB | **SQLite**（`better-sqlite3`、同期 API）+ **FTS5** 全文検索 |
| キャッシュ / セッション | **Redis**（未接続時はインメモリへ自動フォールバック） |
| LLM | `@google/generative-ai`（Gemini）。秘書=ユーザー鍵 / 汎用=Bot 鍵 |
| Discord | `discord.js` v14 |
| Web サーバ | **生 `node:http`**（フレームワーク不使用、独自ルータ） |
| フロントエンド | **依存ゼロのバニラ JS SPA**（PWA / Service Worker 付き） |
| ブラウザ自動操作 | **Rust 製クローラーデーモン** → `puppeteer` フォールバック |
| グラフ描画 | `chart.js` + `@napi-rs/canvas`（PNG 生成） |
| 暗号 | `@node-rs/argon2`（PW マネージャ用）/ Node `crypto`（AES-256-GCM） |
| 認証 | `bcryptjs`(cost 12) + Redis セッション |
| スケジューラ | `node-cron`（ジョブ登録）+ `cron-parser`（次回時刻計算） |

---

## 3. ビルド・実行コマンド

```bash
pnpm install            # 依存導入（Puppeteer が Chromium も取得）
pnpm dev                # 開発: tsx watch src/index.ts（ホットリロード）
pnpm build              # 本番ビルド: Rustクローラー(cargo) → アセットコピー → tsc
pnpm start              # 本番起動: node dist/index.js
```

- **Rust ツールチェイン（stable / `cargo`）が `pnpm build` に必須**（`src/rust_crawler` をビルド）。
- 起動には **環境変数 `YUUKA_ENCRYPTION_SECRET` が必須**。未設定だと `src/index.ts` が即 `exit(1)`（§8）。
- 設定は `config.yaml`（一般設定・git 管理外）と `.env`（機密・git 管理外）。テンプレは [example.yaml](../example.yaml) / [.env.example](../.env.example)。
- 既定ポートはコード上 `3000`（[src/config.ts](../src/config.ts)）だが、本デプロイは `config.yaml` で **7854** に上書き。
- テストフレームワークは未導入（テストランナー無し）。

---

## 4. 全体アーキテクチャ

```
                         ┌──────────────────────────────────────────┐
   Discord ユーザー ──▶  │  src/bot.ts  (複数Botクライアント管理)      │
                         │   ├ 秘書モード → processMessage            │
                         │   └ 汎用モード → processGuildMessage        │
                         └───────────────┬──────────────────────────┘
                                         ▼
                         ┌──────────────────────────────────────────┐
                         │  src/gemini.ts  (LLM対話エンジン)          │
                         │   ・システムプロンプト組立                  │
                         │   ・Function-Calling ループ(最大10反復)     │
                         │   ・補完ハルシネーション検出/補正           │
                         └──┬───────────────────────┬───────────────┘
                            ▼                       ▼
               src/functions/* (LLMツール)   src/services/llmClient.ts
                  registry.dispatch()           (Gemini鍵の払い出し)
                            │
              ┌─────────────┼───────────────────────────────┐
              ▼             ▼                                ▼
        src/db/* (SQLite)  src/services/* (外部連携)   src/services/browserService.ts
        ユーザー単位分離    Google/MCP/Webhook/通知       → Rust crawler / Puppeteer

   別系統(常時稼働):
     ・src/server.ts (生http) ─ Web管理ダッシュボード(SPA) / Webhook受信
     ・src/services/*Service.ts ─ node-cron 常駐ジョブ(リマインド/朝報/日報/家計/バックアップ等)
```

実行の中心は次の 2 つのライフサイクル（§6）と、独立して回るバックグラウンドジョブ群（§7「services」）。

---

## 5. ディレクトリ / モジュールマップ

> AI が「どのファイルを触ればよいか」を引くための索引。関数名・型名は grep 起点として有用。
> **どの機能がどのファイル群を「所有」するか**の正規表は [docs/architecture/architecture_v2.md](../docs/architecture/architecture_v2.md) §10「ファイル所有マップ」。

### 5.1 ルート（横断・統合層 — 編集は慎重に）

| ファイル | 役割 |
|---|---|
| [src/index.ts](../src/index.ts) | エントリポイント。起動シーケンス（secret 検証 → `runMigrations` → `rotateSecretKey` → 招待コード投入 → Redis → Web サーバ → Bot → 常駐サービス群）と 15 秒 watchdog 付きグレースフルシャットダウン |
| [src/config.ts](../src/config.ts) | `config.yaml` + `.env` を優先順位（**env > config.yaml > 既定値**）でマージし `config` を export |
| [src/gemini.ts](../src/gemini.ts) | **LLM 対話エンジンの中核**。`processMessage`/`processGuildMessage`/`processBotDmMessage`、`buildSystemInstruction`、`runFunctionCallingLoop`、補完ハルシネーション検出 |
| [src/bot.ts](../src/bot.ts) | 複数 Discord Bot のライフサイクル（`startBot`/`startCustomBot`/`restartDefaultBot`）、`setupMessageListener`、添付検出、共有招待 DM |
| [src/server.ts](../src/server.ts) | 生 `node:http` サーバ。静的配信（SPA）・CORS/HTTPS・`dispatchRoute` への振り分け |
| [src/types/contracts.ts](../src/types/contracts.ts) | **共有契約型**: `ToolContext` / `FunctionModule` / `RouteDef` / `SessionUser`、`sendJson`。⚠️ **変更禁止**（統合フェーズのみ） |

### 5.2 `src/functions/` — LLM ツール（Function Calling 宣言＋ハンドラ）

各モジュールは `FunctionModule { declarations, handlers }` を export。[src/functions/index.ts](../src/functions/index.ts) が能力（capability）別にマージし、[src/functions/registry.ts](../src/functions/registry.ts) の `dispatch` が実行する。

| ファイル | 主なツール |
|---|---|
| [todoFunctions.ts](../src/functions/todoFunctions.ts) | `addTodo` / `listTodos` / `completeTodo` / `updateTodo` / `organizeTaskPriorities`→`applyTaskPriorities`（2 段階承認） |
| [scheduleFunctions.ts](../src/functions/scheduleFunctions.ts) | `addSchedule` / `listSchedules` / `deleteSchedule`（Google カレンダー双方向同期） |
| [reminderFunctions.ts](../src/functions/reminderFunctions.ts) | `addReminder` / `listReminders` / `cancelReminder`（cron 繰り返し・過去日自動補正） |
| [financeFunctions.ts](../src/functions/financeFunctions.ts) | 家計の最大モジュール。`addExpense` / 予算 / `addPlannedPayment` / `findSettlementCandidates` / `settlePlannedPayment`（消込・自動再生成） |
| [noteFunctions.ts](../src/functions/noteFunctions.ts) | コンテキストノート `appendContextNote` / `getContextNote` / `setContextNote`（システムプロンプトへ常時注入） |
| [clipboardFunctions.ts](../src/functions/clipboardFunctions.ts) | TTL 付き揮発メモ `addClipboardEntry` / `listClipboardEntries` / `deleteClipboardEntry` |
| [contactFunctions.ts](../src/functions/contactFunctions.ts) | 連絡先 `addContact` / `searchContacts`（言及時のみ動的注入）/ 誕生日リマインド連携 |
| [browserFunctions.ts](../src/functions/browserFunctions.ts) | `fetchDynamicPage` / `takePageScreenshot` / `searchWeb` / `browserInteractive*`（open/click/type/wait/status/close） |
| [credentialFunctions.ts](../src/functions/credentialFunctions.ts) | PW マネージャ `listCredentialServices` / `addCredential` / `browserFillCredential`（**復号値は LLM に返さずブラウザへ直接注入**） |
| [playbookFunctions.ts](../src/functions/playbookFunctions.ts) | マクロ `savePlaybook` / `findPlaybooks` / `runPlaybook` / `getRecentActionHistory` |
| [conversationFunctions.ts](../src/functions/conversationFunctions.ts) | 会話ログ `searchConversationLogs`（FTS5）/ `summarizeConversationTopic` |
| [chartFunctions.ts](../src/functions/chartFunctions.ts) | `sendChart`（PNG を `ctx.files` へ push、最大 30 データ点） |
| [briefingFunctions.ts](../src/functions/briefingFunctions.ts) | 朝報・日報・週報の設定 `configureBriefing` / `configureReport` / `runBriefingNow` |
| [botAssistantFunctions.ts](../src/functions/botAssistantFunctions.ts) | 汎用モード専用。ギルドメンバー管理 / 個人ノート / ギルド共有ノート / ギルド内会話検索（`requireGuild` ガード） |
| [mcpDynamic.ts](../src/functions/mcpDynamic.ts) | 登録済み MCP サーバの Tool を動的に `FunctionDeclaration` 化（JSON Schema→Gemini 変換、実行前確認フラグ、呼出時の可用性再チェック） |
| [registry.ts](../src/functions/registry.ts) / [index.ts](../src/functions/index.ts) | レジストリ構築・宣言の重複排除・能力別フィルタ・`dispatch` ループ |

### 5.3 `src/db/` — リポジトリ層（SQLite, ユーザー単位分離）

スキーマの**唯一の定義元は** [src/db/migrations.ts](../src/db/migrations.ts)（**schema v3** / 各 Repo はテーブルを再定義しない）。各 Repo は `xxxRepo.ts` + 型 `xxxRecord`。

| ファイル | 役割 |
|---|---|
| [migrations.ts](../src/db/migrations.ts) | スキーマ v3 全定義。レガシー DROP・`bot_id` スコープ化移行・暗号化列レジストリ（鍵ローテ用）。⚠️ **変更は統合フェーズのみ** |
| [database.ts](../src/db/database.ts) | `better-sqlite3` 初期化、WAL / `foreign_keys=ON`、`getDb()` / `closeDb()` |
| [redis.ts](../src/db/redis.ts) | Redis クライアント・再接続バックオフ。未接続時は `null` を返しフォールバック誘導 |
| [userRepo.ts](../src/db/userRepo.ts) | ユーザー CRUD、bcrypt(cost12)、role(RBAC)、Gemini 鍵/Google OAuth(暗号化)、salt、通知先・各種設定 |
| [messageLogRepo.ts](../src/db/messageLogRepo.ts) | 全会話の永続化（SQLite が正）+ Redis コンテキスト二重書き、**FTS5**、`(user_id, bot_id[, guild_id])` スコープ |
| [todoRepo.ts](../src/db/todoRepo.ts) / [expenseRepo.ts](../src/db/expenseRepo.ts) / [plannedPaymentRepo.ts](../src/db/plannedPaymentRepo.ts) | ToDo / 収支台帳・月次集計・予算 / 繰り返し支払い・消込リンク |
| [reminderRepo.ts](../src/db/reminderRepo.ts) / [scheduleRepo.ts](../src/db/scheduleRepo.ts) | リマインド（cron・複数 source）/ Google カレンダー同期予定 |
| [contactRepo.ts](../src/db/contactRepo.ts) / [contextNoteRepo.ts](../src/db/contextNoteRepo.ts) / [clipboardRepo.ts](../src/db/clipboardRepo.ts) | 連絡先 / コンテキストノート(≤10k) / 揮発クリップボード(TTL) |
| [credentialRepo.ts](../src/db/credentialRepo.ts) | PW マネージャ永続化（Argon2id+AES-256-GCM、一覧は暗号列を SELECT しない） |
| [botRepo.ts](../src/db/botRepo.ts) | Bot インスタンス CRUD、トークン暗号化、Bot 共有（pending/active/revoked）、`hasBotAccess` |
| [botAttributesRepo.ts](../src/db/botAttributesRepo.ts) / [botNoteRepo.ts](../src/db/botNoteRepo.ts) | Bot 能力プリセット・ギルド許可/メンバー / Bot スコープのノート（個人・ギルド共有） |
| [personaRepo.ts](../src/db/personaRepo.ts) | ペルソナ（≤20k、公開フラグ、マーケットプレイス） |
| [webhookRepo.ts](../src/db/webhookRepo.ts) / [mcpRepo.ts](../src/db/mcpRepo.ts) | 受信 Webhook エンドポイント・配信監査 / MCP サーバ（system/user スコープ・tools キャッシュ） |
| [briefingConfigRepo.ts](../src/db/briefingConfigRepo.ts) / [reportConfigRepo.ts](../src/db/reportConfigRepo.ts) | 朝報設定 / 日報・週報設定 |
| [auditRepo.ts](../src/db/auditRepo.ts) | 監査ログ（**パスワード/鍵本体は記録禁止**） |
| [inviteRepo.ts](../src/db/inviteRepo.ts) / [systemSettingsRepo.ts](../src/db/systemSettingsRepo.ts) | 招待コード（1 回限り・失効可）/ key-value（`schema_version` 等） |

### 5.4 `src/services/` — バックグラウンドジョブ・外部連携・基盤

| ファイル | 役割 / トリガ |
|---|---|
| [llmClient.ts](../src/services/llmClient.ts) | Gemini クライアント払い出し: `getUserGenAI`(秘書=ユーザー鍵) / `getBotGenAI`(汎用=Bot 鍵) / `generateAuxText`(補助生成・リトライ) |
| [notifier.ts](../src/services/notifier.ts) | 送信基盤 `sendToUser(userId, payload, target?, botId?)`。クライアント解決＋チャンネル/DM 振り分け |
| [sessionService.ts](../src/services/sessionService.ts) | Redis セッション（SHA256 鍵・7 日スライディング・PW 変更で全失効） |
| [secretService.ts](../src/services/secretService.ts) | PW マネージャ高レベル API（登録/復号＋監査フック） |
| [passwordPolicy.ts](../src/services/passwordPolicy.ts) | パスワードポリシー（8 字以上・2 種以上・1 万件ブラックリスト） |
| [browserService.ts](../src/services/browserService.ts) | **ブラウザ自動操作の中核**（1054 行）。Rust デーモン IPC / Puppeteer フォールバック / `data-yuuka-id` 注釈 / 永続セッション。⚠️ §8 不変層 |
| [botCapabilities.ts](../src/services/botCapabilities.ts) / [botRateLimit.ts](../src/services/botRateLimit.ts) | Bot 能力プリセット解決（secretary / mcp_assistant）/ 3 段レート制限 |
| [actionRecorder.ts](../src/services/actionRecorder.ts) | マクロ学習用に直近 Function Call 履歴を記録（認証系・記録系は除外） |
| [reminderEngine.ts](../src/services/reminderEngine.ts) | 🔔 毎分。期限・ToDo・予定リマインド配信（全ユーザー横断 = cron 例外） |
| [briefingService.ts](../src/services/briefingService.ts) | 🌅 朝報。Open-Meteo 天気 + RSS を LLM 要約して配信 |
| [reportService.ts](../src/services/reportService.ts) | 📋 日報・週報。ToDo/予定/収支/会話トピックを集約・LLM 要約 |
| [paymentRecurrenceService.ts](../src/services/paymentRecurrenceService.ts) | 💳 毎日 00:05。繰り返し支払いを次回期日へ前進 |
| [playbookScheduleService.ts](../src/services/playbookScheduleService.ts) | マクロの cron 定期実行（user×playbook 単位） |
| [backupService.ts](../src/services/backupService.ts) | 💾 毎時。ユーザー単位 SQLite 抽出→ZIP→各自の Google Drive へ世代管理 |
| [birthdayReminderService.ts](../src/services/birthdayReminderService.ts) / [clipboardCleanupService.ts](../src/services/clipboardCleanupService.ts) | 🎂 毎日 08:00 誕生日通知 / 🧹 毎時 期限切れ削除 |
| [autoTagService.ts](../src/services/autoTagService.ts) | ToDo 作成/更新後に LLM でタグ自動付与（非同期・非ブロッキング） |
| [webhookProcessor.ts](../src/services/webhookProcessor.ts) | 受信 Webhook 処理（HMAC 検証 → LLM 解釈 → 通知 → 任意で ToDo/リマインド化） |
| [receiptParser.ts](../src/services/receiptParser.ts) | レシート画像を Gemini で解析し家計簿登録（Function Calling 経由） |
| [googleCalendarService.ts](../src/services/googleCalendarService.ts) / [googleDriveService.ts](../src/services/googleDriveService.ts) | Google OAuth2・カレンダー双方向同期 / Drive バックアップ |
| [mcpClient.ts](../src/services/mcpClient.ts) | MCP クライアント（JSON-RPC 2.0 over HTTP/SSE: initialize / tools/list / tools/call） |
| [chartService.ts](../src/services/chartService.ts) | chart.js + canvas でダークテーマ PNG 生成 |
| [playbookService.ts](../src/services/playbookService.ts) | マクロ（Playbook）CRUD の基盤 |

### 5.5 `src/server/` — HTTP ルーティング

[src/server/routeRegistry.ts](../src/server/routeRegistry.ts) が `RouteDef[]` を集約しパス照合・ボディ解析・認可・`ctx` 構築。[src/server/httpHelpers.ts](../src/server/httpHelpers.ts) がセッション Cookie 解決。各機能のルートは `src/server/routes/*.ts`:

`authRoutes`（ログイン/登録）, `settingsRoutes`（個人設定・最大）, `botRoutes`, `botAttributeRoutes`, `adminRoutes`（管理・監査ログ）, `todoRoutes`, `scheduleRoutes`, `financeRoutes`, `reminderRoutes`, `personalRoutes`（ノート/クリップボード/連絡先）, `personaRoutes`, `playbookRoutes`, `credentialRoutes`, `deliveryRoutes`（朝報/日報）, `webhookRoutes`（`POST /hook/:token` のみ `auth:"none"`）, `mcpRoutes`。

認可は `RouteAuth`: `"none"` / `"user"`（セッション必須）/ `"admin"`（role 確認）。`auth:"user"` のリソースは必ず `ctx.user.discordId` でスコープする。

### 5.6 フロントエンド / クローラー / ユーティリティ

| 場所 | 内容 |
|---|---|
| [src/public/](../src/public/) | **依存ゼロのバニラ JS SPA**。`app.js`（History API ルーティング・`fetch` ラッパが `botId` を自動注入・タブ別データ取得）、`index.html`、`styles.css`、`sw.js`（PWA）、`manifest.json` |
| [.cursorrules](../.cursorrules) | **UI デザイン制約**: Material Design 2 ダーク。⚠️ **カードコンポーネント禁止**（フラットリスト + 下線区切り） |
| [src/rust_crawler/](../src/rust_crawler/) | Rust 製クローラー（`src/main.rs`: デーモン IPC・fetch・fetch-js・screenshot・Google+DuckDuckGo 検索を RRF ランキング） |
| [src/utils/](../src/utils/) | `crypto.ts`(暗号), `embeds.ts`(Discord Embed・色規約), `formatters.ts`, `datetime.ts`(`YYYY-MM-DD HH:MM:SS`), `discordMarkdown.ts`, `yamlParser.ts`(依存ゼロ YAML) |
| [src/assets/](../src/assets/) | `common-passwords-10k.txt`（PW ブラックリスト） |

---

## 6. 主要ランタイムフロー

### 6.1 Discord メッセージ → 返信（中核フロー）

1. **受信/振り分け** — [src/bot.ts](../src/bot.ts) `setupMessageListener`: Bot 自身/未 ready を除外、メンション/リプライ/DM 判定、登録・権限・レート制限ゲート。
2. **モード分岐** — `isGuildAssistantBot` で 秘書(`processMessage`) か 汎用(`processGuildMessage`/`processBotDmMessage`) を選択。自メンション除去、リプライ連鎖から文脈接頭辞、添付（`image/*`→画像, `audio/*`→音声）を Base64 化。
3. **入口/分離** — [src/gemini.ts](../src/gemini.ts): `ToolContext` に `userId`×`botId`（汎用は `guildId`）で分離確立。秘書は `getUserGenAI`、汎用は `getBotGenAI` で Gemini ハンドル取得（**鍵が無ければ実行しない**）。
4. **文脈組立** — 発話を `addMessageLog` で記録 → Redis 直近（秘書 15 / 汎用 30 件、ミス時 SQLite から再構築）→ リプライ連鎖解決 → `Contents[]` 構築。
5. **システムプロンプト** — `buildSystemInstruction`: ペルソナ → メモリ規則 → 承認フロー → 検索スキル → 現在日時(JST) → カレンダー → コンテキストノート の順（順序は契約）。
6. **ツール集合** — `resolveBotCapabilities` で能力フィルタ → 静的モジュール + MCP 動的モジュールを `buildFunctionRegistry` でマージ。
7. **Function Calling ループ** — `runFunctionCallingLoop`（最大 10 反復）: `generateWithRetry`（429/5xx は指数バックオフ）→ functionCall を `registry.dispatch(ctx, name, args)` で実行 → 結果（JSON 文字列）を contents へ追記 → 再生成。
8. **補完ハルシネーション補正** — ツール未実行なのに「登録した/やっておいた」等と主張した場合のみ、補正プロンプトを 1 回注入し再生成。
9. **リッチ返信** — ハンドラが `ctx.embeds` / `ctx.files`（グラフ PNG）を積む。`richReplyEnabled=false` なら抑制。
10. **永続化/送信** — 応答を `addMessageLog('assistant')` → `toDiscordMarkdown` → 2000 字分割（embeds/files は最終チャンクのみ）→ `safeReply`（例外を握り潰しプロセス死を防止）。

> 詳細: [docs/spec/discordbot_spec.md](../docs/spec/discordbot_spec.md) §3.1（対話エンジン）, [docs/architecture/architecture_v2.md](../docs/architecture/architecture_v2.md) §5（LLM 層）。

### 6.2 HTTP リクエスト → 応答（管理ダッシュボード）

1. [src/server.ts](../src/server.ts) `serverHandler`: HTTPS リダイレクト確認・CORS（baseUrl ホスト一致のみ反映）→ `dispatchRoute`。
2. [src/server/routeRegistry.ts](../src/server/routeRegistry.ts): メソッド/パス照合 → `RouteAuth` 認可 → Cookie からセッション解決（[sessionService](../src/services/sessionService.ts)、Redis or インメモリ）→ アクセス毎に TTL 延長。
3. ボディ解析（POST/DELETE、最大 10MB、JSON）→ パスパラメータ抽出（`:name`）→ `RouteRequestCtx` 構築 → ハンドラ実行 → `sendJson`。
4. 未マッチ: `/api/*` は 404 JSON、その他は静的配信（拡張子無しは SPA の `index.html` へフォールバック）。
5. 認可失敗: `auth:"user"` 無セッション=401、`auth:"admin"` 非管理者=403。Cookie は `__Host-yuuka-session`(HTTPS)/`yuuka-session`(HTTP)、HttpOnly。

---

## 7. データモデルの要点

- **正規の定義元は [src/db/migrations.ts](../src/db/migrations.ts)（schema v3）**。Repo はテーブルを再定義しない。テーブル一覧と列の概要は [docs/architecture/architecture_v2.md](../docs/architecture/architecture_v2.md) §2 にも表がある。
- 日時は一貫して **`'YYYY-MM-DD HH:MM:SS'`（ローカル時刻テキスト、`datetime('now','localtime')`）**。
- 暗号化列は `[encrypted, iv, auth_tag]` の 3 つ組。種類により鍵が異なる（§8）。
- `message_logs` / `bot_context_notes` / `bot_members` は **`users` への FK を持たない**（Web 未登録の Discord ユーザーも記録するため）。これは意図的（汎用モードの分離キー仕様）。
- スキーマ進化: ドキュメント [architecture_v2.md](../docs/architecture/architecture_v2.md) は v2 基盤を記述、**コードは Bot スコープ拡張で v3**（`(user_id)` 制約を `(user_id, bot_id)` へ再構築、既定 `bot_id='system_default'`）。差異に注意。

---

## 8. 絶対に守る不変条件（CRITICAL）

> 出典は [docs/architecture/architecture_v2.md](../docs/architecture/architecture_v2.md) §0・[docs/spec/bot_attributes_requirements.md](../docs/spec/bot_attributes_requirements.md)。新規実装はこれらを破ってはならない。

1. **データ分離**: 全ユーザーデータクエリは `WHERE user_id = ?` を必須とする。`user_id` 無しのワイルドカード走査禁止（cron の全件走査のみ例外＝明示コメント必須）。**例外**: 汎用モードは `bot_id × user_id`（`bot_context_notes`）/ `bot_id × guild_id`（`bot_guild_notes` 等）を正規の分離キーとする。
2. **ブラウザ操作層は不変**: [src/services/browserService.ts](../src/services/browserService.ts) / [src/rust_crawler/](../src/rust_crawler/) / [src/functions/browserFunctions.ts](../src/functions/browserFunctions.ts) の既存方式（Rust デーモン→Puppeteer、ユーザー別永続セッション、`data-yuuka-id` 数値 ID 注釈）は変更しない。新機能はこの上に載せる。
3. **認証情報を LLM に渡さない**: PW マネージャの復号値は `browserService` へ直接渡す。Function の戻り値・ログ・プロンプトに含めない。旧 `getCredential`（平文返却）は廃止。全アクセスは監査ログへ（PW 本体は記録しない）。
4. **変更禁止ファイル**（統合フェーズのみ可）: [src/types/contracts.ts](../src/types/contracts.ts)・[src/db/migrations.ts](../src/db/migrations.ts)・[src/utils/crypto.ts](../src/utils/crypto.ts)。横断ファイル（`gemini.ts`/`bot.ts`/`index.ts`/`server.ts`/`functions/index.ts`/`public/*`）も統合時のみ編集。
5. **暗号は 2 層**:
   - システム鍵（`YUUKA_ENCRYPTION_SECRET` から scrypt 派生）+ AES-256-GCM = **API キー・Discord トークン・OAuth・Webhook シークレット・MCP 認証**用 → `encryptText`/`decryptText`。
   - **per-user 鍵**（`Argon2id(secret, user.salt)`）+ AES-256-GCM = **PW マネージャ専用** → `encryptForUser`/`decryptForUser`。`users.salt` は不変（変更すると全認証情報が復号不能）。
   - `YUUKA_ENCRYPTION_SECRET` 未設定で起動失敗。`YUUKA_ENCRYPTION_SECRET_NEW` 設定時は起動時 `rotateSecretKey` で全再暗号化。
6. **LLM 鍵のスコープ**: 秘書=`getUserGenAI`（ユーザー自身の鍵のみ、無ければエラー、Bot 鍵へフォールバックしない）/ 汎用=`getBotGenAI`（Bot 鍵、発話者の個人鍵は使わない）。
7. **Function 戻り値は JSON 文字列**。承認が必要な操作（`applyTaskPriorities`/`settlePlannedPayment`/`runPlaybook`/`addCredential` 等）は提案 JSON を返し、**LLM がユーザー確認 → 承認後に確定 Function を再呼び出し**する 2 段階方式。自動確定しない。
8. **リッチ返信ゲート**: `ctx.richReplyEnabled === false` のとき embeds/files を生成せず、その旨の `{success:false,...}` を返す。

---

## 9. コーディング規約

- **ESM**: 相対 import は **`.js` 拡張子付き**（例 `import { x } from "./foo.js"`）。型は明示。
- **新規 npm 依存の追加は禁止**（導入済みのみ使用: `bcryptjs`, `@node-rs/argon2`, `rss-parser`, `@napi-rs/canvas`, `chart.js`, `cron-parser` 等）。
- **コメント・ログは日本語**。セクション区切り `// ─── ... ───`、絵文字ログ（`🔔🌅📋💳🎂🧹💾✅❌` 等）の既存スタイルを踏襲。
- **Function 命名**: 既存名は維持（UX 互換）、新規は lowerCamelCase。`declarations` の `description` は **日本語で具体的に**（LLM が使い分けられるよう）。名前衝突禁止。
- **新規 HTTP ルート**: `src/server/routes/*.ts` に `RouteDef[]` を export → `server.ts` の `registerRoutes()` に登録。
- **cron 系サービス**: `node-cron` でジョブ登録、ユーザー設定の繰り返しは `cron-parser` で次回時刻計算。多重実行を `ticking` フラグでガード。通知は必ず `notifier.sendToUser` 経由。
- **秘密の取り扱い**: ログ/エラー文字列に PW・トークンを出さない（`sanitizeErrorMessage` / 引数マスク）。

---

## 10. よくある作業の入口

| やりたいこと | 触る場所 |
|---|---|
| LLM ツールを追加 | `src/functions/<domain>Functions.ts` に宣言+ハンドラ → [src/functions/index.ts](../src/functions/index.ts) でマージ（必要なら能力マップ更新）。データは `src/db/<domain>Repo.ts` |
| DB テーブル/列を追加 | [src/db/migrations.ts](../src/db/migrations.ts)（唯一の定義元）→ 対応 Repo。⚠️ 統合フェーズ扱い |
| HTTP API を追加 | `src/server/routes/*.ts` に `RouteDef[]` → `server.ts` で `registerRoutes`。`ctx.user.discordId` でスコープ |
| 定期ジョブを追加 | `src/services/<name>Service.ts` に `start/stop` を実装 → [src/index.ts](../src/index.ts) の起動/終了シーケンスへ登録 |
| ダッシュボード UI を変更 | [src/public/app.js](../src/public/app.js) / `index.html` / `styles.css`。⚠️ [.cursorrules](../.cursorrules)（カード禁止）厳守 |
| Discord 応答整形を変更 | [src/bot.ts](../src/bot.ts)（分割・送信）/ [src/utils/embeds.ts](../src/utils/embeds.ts)（色・Embed）/ [src/utils/discordMarkdown.ts](../src/utils/discordMarkdown.ts) |
| ペルソナ/対話の挙動を変更 | [src/gemini.ts](../src/gemini.ts)（システムプロンプト組立・ループ）。⚠️ 横断ファイル |

---

## 11. 既存ドキュメントの権威順序

矛盾時の優先順位（上が強い）:

1. [docs/architecture/architecture_v2.md](../docs/architecture/architecture_v2.md) — **実装規範・不変条件**（§0 do-not-change、§2 スキーマ、§10 ファイル所有マップ）。仕様と矛盾したら**こちらが優先**。
2. [docs/spec/bot_attributes_requirements.md](../docs/spec/bot_attributes_requirements.md) — Bot 動作モード拡張（capability、2 層メモリ、汎用モードのスコープ）。
3. [docs/spec/discordbot_spec.md](../docs/spec/discordbot_spec.md) — **マスター機能仕様 v0.6.1**（§3 機能、§5 ユーザー/Bot、§6 PW マネージャ、§7 会話履歴、§8 バックアップ、§9 外部連携）。
4. [docs/skills/search_skills.md](../docs/skills/search_skills.md) — 検索クロール時の LLM 指示（システムプロンプトへ注入。天気=気象庁優先 等）。
5. [README.md](../README.md) — 人間向け概要・セットアップ（非規範）。

> 用語の対応に注意: 仕様の「マクロ」＝実装の「Playbook」（同一機能）。

---

## 12. 落とし穴（抜粋）

- **起動失敗**: `YUUKA_ENCRYPTION_SECRET` 未設定で即終了。鍵を変えると既存の暗号化データは復号不能（ローテは `_NEW` 経由）。
- **データ消失**: v1 レガシースキーマ検出時、`migrations.ts` は旧テーブルを **DROP**（不可逆）。
- **discord.js v14**: destroy 済みクライアントは再ログイン不可。`restartDefaultBot` は**新インスタンスを生成**して live binding を差し替える。
- **会話の正は SQLite**: Redis はキャッシュ。`message_logs` は自動削除されない（`clearContext` は Redis 境界マークのみ）。
- **MCP 実行前確認**: `requires_confirmation` は DB のフラグのみ。実際の確認はエージェント/ツール呼出層の責務。
- **autoTag は `setImmediate` の fire-and-forget**: ToDo 削除と競合しうる（`getTodoById` で防御）。
- **Google refresh_token は自動更新されない**: 失効時 `isCalendarEnabled` は静かに false。

---

_最終更新: 2026-06-15 / このファイルはリポジトリ解析に基づく AI 向け索引です。実装が動けば、まず該当ファイルの実コードを正とし、本書とズレがあれば本書を更新してください。_
