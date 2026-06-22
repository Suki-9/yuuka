# Yuuka v2 アーキテクチャ規範（仕様書 docs/spec/discordbot_spec.md v0.6.2 準拠 / DB schema v9）

本書は仕様書（docs/spec/discordbot_spec.md）を既存コードベースへ落とし込むための**実装規範**である。
実装エージェント・開発者は必ず本書のコントラクトに従うこと。仕様書と本書が矛盾する場合は本書を優先する（本書は仕様書を既存実装と調和させた結果である）。

---

## 0. 最重要原則

1. **データ分離**: 全ユーザーデータは `user_id`（DiscordユーザーID, TEXT）を WHERE 句の必須条件とする。`user_id` なしのワイルドカードクエリ禁止（cron系の全件走査は例外として明示コメントを書く）。
   **例外パターン（Bot属性 docs/spec/bot_attributes_requirements.md §6）**: 汎用モード（MCPアシスタント）のデータは `bot_id × user_id`（bot_context_notes）/ `bot_id × guild_id`（bot_guild_notes, bot_guilds, message_logs のギルド会話）の複合スコープを正式な分離キーとする。この user_id にはWebアカウント未登録のDiscordユーザーIDも入るため、message_logs / bot_context_notes / bot_members は users へのFKを持たない。
2. **ブラウザ操作層は不変**: `src/services/browserService.ts`・`src/rust_crawler/`・`src/functions/browserFunctions.ts` の既存アプローチ（Rustクローラーデーモン→Puppeteerフォールバック、ユーザー別永続セッション、`data-yuuka-id` 数値IDアノテーション）は変更しない。新機能はこの上に乗せる。
3. **認証情報はLLMに渡さない**: パスワードマネージャの復号値は `browserService` へ直接渡す。Function Call の戻り値・ログ・プロンプトに含めてはならない。
4. **スキーマは前方移行する**: 現在の `SCHEMA_VERSION` は **"9"**。初版（v2 全面再構築）以降は破壊的再構築は行わず、`migrations.ts` の各 `migrate*` 関数が冪等な ALTER / 追加テーブルで段階移行する（v3〜v9 の概要は §2 末尾参照）。
5. **コメント・ログは日本語**、既存コードのスタイル（セクション区切りコメント `// ─── ... ───`、絵文字ログ）を踏襲する。
6. **TypeScript / ESM**: import は `.js` 拡張子付き相対パス。型は明示的に。新規依存の追加は原則禁止（導入済み: bcryptjs, @node-rs/argon2, rss-parser, @napi-rs/canvas, chart.js, cron-parser, archiver。lint/format は `@biomejs/biome`、型チェックは `tsgo`）。

---

## 1. 共有コントラクト（src/types/contracts.ts）

全モジュールは `src/types/contracts.ts` の型に依存する。**このファイルを変更してはならない**（変更が必要なら統合フェーズで行う）。

```ts
// ToolContext: Function Call ハンドラに渡される実行コンテキスト
export interface ToolContext {
  botId: string;     // 実行中のBotインスタンスID（通知送信のクライアント解決に使用）
  userId: string;    // DiscordユーザーID（データ分離キー。全リポジトリ呼び出しに必須）
  guildId?: string;  // 発話ギルドID（汎用モード等のギルド常駐Botのみ。DM/秘書では undefined）
  embeds: EmbedBuilder[];                 // リッチ返信キュー（push すると返信に添付）
  files: { attachment: Buffer; name: string }[]; // ファイル添付キュー（グラフPNG等）
  richReplyEnabled: boolean;              // ユーザー設定（falseならembeds/files禁止）
}

// FunctionModule: 各機能モジュールが export する束
export interface FunctionModule {
  declarations: FunctionDeclaration[];
  handlers: Record<string, (ctx: ToolContext, args: Record<string, unknown>) => Promise<string> | string>;
}

// RouteModule: HTTPルートモジュール
export type RouteAuth = "none" | "user" | "admin";
export interface RouteRequestCtx {
  req: IncomingMessage; res: ServerResponse;
  url: URL;
  user: SessionUser | null;     // auth:"none" の場合 null の可能性あり
  body: Record<string, unknown>; // JSONボディ（パース済、無ければ {}）
  rawBody: Buffer;               // HMAC検証用の生ボディ
  params: Record<string, string>; // パスパターン :name の解決値
}
export interface RouteDef {
  method: "GET" | "POST" | "DELETE" | "OPTIONS";
  path: string;                  // 例 "/api/contacts", "/hook/:token"
  auth: RouteAuth;
  handler: (ctx: RouteRequestCtx) => Promise<void>;
}
export interface SessionUser { discordId: string; username: string; role: "user" | "admin"; }
```

ハンドラ内のレスポンスは `sendJson(res, statusCode, obj)`（contracts.ts からexport）を使う。

### Function ハンドラの戻り値
- JSON文字列を返す（既存スタイル）: `JSON.stringify({ success: true, ... })` / `{ success: false, message })`。
- ユーザーへの確認が必要な操作（仕様の承認フロー）は、確認待ちであることを示すJSONを返し、**LLMがユーザーへ確認文を提示**する。承認後にLLMが確定用Functionを再度呼ぶ2段階方式とする（例: `organizeTaskPriorities` → 提案JSON → ユーザー承認 → `applyTaskPriorities`）。

---

## 2. DBスキーマ v9（src/db/migrations.ts が唯一の定義元）

スキーマは migrations.ts に集約済み（現 `SCHEMA_VERSION="9"`）。各リポジトリは**テーブルを再定義しない**。主要テーブル（全列は migrations.ts 参照）:

| テーブル | キー/スコープ | 用途 |
|---|---|---|
| users | discord_id PK | 認証(bcrypt cost12) + salt(hex) + ユーザー設定(rich_reply_enabled, remind_default_minutes, notify_target_*, active_persona_id〔レガシー: ペルソナ適用は v8 で bot_active_personas へ移行〕, timezone) + Gemini鍵(enc) + バックアップ設定 |
| bots | id PK, owner user_id | Botインスタンス（Discordトークンenc, recommended_persona_id, suspended〔管理者処分〕, **stopped〔v9: オーナー手動停止。再起動後も維持〕**, **capabilities〔JSON: ケーパビリティ集合〕**, **persona_id〔v8: Bot単位ペルソナ〕**, **gemini_api_key_*〔Bot専用キーenc。汎用モードは設定必須〕**, discord_application_id〔招待リンク導出〕） |
| bot_shares | bot_id, shared_user_id | 共有招待 status: pending/active/revoked |
| personas | id PK, owner_id | name, prompt(≤20000), is_public |
| message_logs (+ message_logs_fts FTS5) | user_id (+ bot_id, guild_id) | 全会話永続化, discord_msg_id, reply_to_msg_id, role: user/assistant。guild_id=NULL はDM/秘書利用、非NULLは汎用モードのギルド会話 |
| todos | user_id | title, description, due_date, priority(high/medium/low/null), tags(JSON), status(open/done), linked_payment_id |
| schedules | user_id | Googleカレンダー同期予定（既存構造を user スコープ化） |
| reminders | user_id | message, trigger_at, repeat_rule(cron), target_type(dm/channel)+target_id, status(pending/sent/cancelled), source(manual/todo/schedule/payment/birthday/webhook), source_id |
| expenses | user_id | type(income/expense), amount, category, memo, date, source(manual/receipt_ocr) |
| budget_limits | user_id, category | 月次予算上限 |
| planned_payments | user_id | title, amount, category, due_date, repeat_rule, status(pending/settled/cancelled), settled_expense_id, linked_todo_id, linked_reminder_id |
| playbooks | user_id, name UNIQUE | マクロ=Playbook（title, keywords JSON, description, steps テキスト）。仕様§3.6のMacroはこのテーブルで実現する |
| playbook_schedules / playbook_runs | user_id | cron定期実行（既存機能を user スコープ化、bot_id は通知用に保持） |
| context_notes | user_id PK | content(≤10000) 単一ドキュメント |
| clipboard_entries | user_id | content, expires_at(NULL=無期限) |
| contacts | user_id | name, birthday, relationship, contact_info, notes, tags(JSON) |
| credentials | user_id, service_name | PWマネージャ。username, url, encrypted_password/iv/auth_tag（**ユーザー鍵で暗号化**） |
| webhook_endpoints | user_id, token UNIQUE | name, secret(enc), notify_target, template, filter_keyword, create_todo, create_reminder, enabled |
| webhook_deliveries | endpoint_id | 受信監査ログ payload, status |
| briefing_configs | user_id PK | 朝報: enabled, schedule_cron, target, weather_lat/lng, location_name, news_feeds(JSON), news_keywords(JSON) |
| report_configs | user_id, type(daily/weekly) | enabled, schedule_cron, target |
| mcp_servers | id PK, owner_id, (user_id, bot_id) スコープ | name, endpoint_url, auth_credential(enc), tools_cache(JSON), enabled, requires_confirmation。v4 で (user_id, bot_id) へ、v7 で owner_id 次元を追加（クロステナント露出修正） |
| audit_logs | user_id | action, target, detail（PW本体は記録禁止） |
| invite_codes / system_settings | 既存どおり |

**汎用モード（MCPアシスタント）／Bot属性のテーブル**（bot_attributes_requirements.md §5。複合スコープが正式な分離キー）:

| テーブル | キー/スコープ | 用途 |
|---|---|---|
| bot_active_personas | (user_id, bot_id) PK | v8: 秘書ペルソナの適用状態（旧 users.active_persona_id を Bot 単位へ分離） |
| bot_context_notes | (bot_id, user_id) | 汎用モードの個人ノート（users へFKなし＝未登録Discord IDも可） |
| bot_guild_notes | (bot_id, guild_id) | 汎用モードのギルド共有ノート |
| bot_guilds | (bot_id, guild_id) | 応答許可ギルドリスト |
| bot_members | (bot_id, guild_id, user_id) | 汎用モードの利用メンバー（users へFKなし） |
| bot_mcp_access | (bot_id, owner_id, mcp_server_id) | Bot が利用可能な MCP サーバーの許可リスト |
| bot_credential_access | (bot_id, owner_id, service_name) | Bot が利用可能な認証情報の許可リスト |
| user_google_accounts | owner(user_id) | v5: Google 複数アカウント連携（OAuth enc, primary フラグ） |
| bot_google_account | (bot_id) | v5: Bot ごとに割り当てる Google アカウント（NULL 許容 v7+） |

**マイグレーション履歴**（各 `migrate*` 関数は冪等。新規DBは最終形を直接 CREATE）:
v2=初版全面再構築 / v3=ユーザーデータ各表へ bot_id 付与（`migrateToBotScopedData`）/ v4=MCP を (user_id, bot_id) 化（`migrateMcpToBotScope`）/ v5=owner リソース許可・Google複数アカウント（`migrateOwnerResourceGrants`）/ v6–v7=MCP/リソース許可へ owner_id 次元追加・bot_google_account を NULL 許容化（`migrateMcpAccessOwnerScope`・`migrateBotGoogleAccountNullable`）/ v8=ペルソナを Bot 単位化（`migratePersonaToBotScope`）/ v9=bots.stopped 追加。

日時は既存スタイル（`datetime('now','localtime')` の `YYYY-MM-DD HH:MM:SS` テキスト）に合わせる。

---

## 3. 暗号（src/utils/crypto.ts v2 — 変更禁止、利用のみ）

- `encryptText / decryptText`: システム鍵（scrypt(YUUKA_ENCRYPTION_SECRET)）。**用途: APIキー・Discordトークン・OAuthトークン・Webhookシークレット・MCP認証情報**。
- `encryptForUser(userId, text)` / `decryptForUser(userId, enc, iv, tag)`: **Argon2id(YUUKA_ENCRYPTION_SECRET, user.salt)** から導出した32byte鍵 + AES-256-GCM。**用途: パスワードマネージャ（credentials テーブル）のみ**。鍵はメモリ内キャッシュ。
- YUUKA_ENCRYPTION_SECRET は `config.secretKey`（環境変数/設定 `YUUKA_ENCRYPTION_SECRET`、後方互換で `SECRET_KEY`）。
- `YUUKA_ENCRYPTION_SECRET_NEW` が設定されている場合、起動時に `rotateSecretKey()` が全暗号化データを再暗号化する（crypto.ts 実装済）。

## 4. 認証・セッション

- パスワード: bcryptjs cost 12。ポリシー: 8文字以上 + 大文字/小文字/数字/記号のうち2種以上 + `src/assets/common-passwords-10k.txt`（読み込みは `passwordPolicy.ts`）との一致拒否。
- セッション: Redis `session:{sha256(token)}` に SessionUser JSON、TTL 7日、アクセス毎にTTL延長（スライディング）。Redis不通時は in-memory フォールバック。ユーザー毎の発行済セット `user_sessions:{userId}` を保持し、パスワード変更時に全失効。
- 実装: `src/services/sessionService.ts`（createSession/getSession/touchSession/destroySession/destroyAllForUser）。

## 5. LLM層

- `src/services/llmClient.ts`（基盤提供）:
  - `getUserGenAI(userId): { genAI, model } | null` — **ユーザー自身のGemini APIキーのみ**使用（仕様§4.2。秘書系の対話・補助生成はこちら）。
  - `getBotGenAI(botId): { genAI, model } | null` — **Bot専用キー**（bots テーブルへ暗号化保存）。汎用モード（MCPアシスタント）の対話のみが使用し、発話ユーザーの個人キーは使わない（bot_attributes_requirements.md §4.3.3）。
  - `generateAuxText(userId, prompt, systemInstruction?): Promise<string>` — タグ自動付与・Webhook解釈・レポート要約などの補助生成用（Function Callなし、リトライ付き）。
- `src/gemini.ts`: コンテキスト復元、返信チェーン解決、ペルソナ+コンテキストノート注入、MCP動的ツール、リッチ返信ゲート。Redis 会話キャッシュキーは利用形態で分かれる（`src/db/messageLogRepo.ts`）:
  - `context:{botId}:secretary:{userId}` — 秘書モード（個人 DM）。
  - `context:{botId}:{guildId}` — 汎用モードのギルド会話。
  - `context:{botId}:dm:{ownerId}` — 汎用モードの owner DM。
  - リセット境界は `context_floor:{botId}:{userId}` / `context_floor:{botId}:dm:{ownerId}`（会話履歴クリアの基準時刻）。
- 会話履歴の正は `message_logs`（SQLite, (user_id, bot_id, guild_id) スコープ）。Redisキャッシュ消失時はSQLiteから再構築。

## 6. リッチ返信（§3.0）

- Embed: 既存 `showRichContent` を継続。カラー規約は仕様§3.0.2 の HEX を `src/utils/embeds.ts` の COLOR_MAP に追加。
- グラフ: `src/services/chartService.ts` が chart.js + @napi-rs/canvas でPNG生成（ダークテーマ: 背景 #2B2D31, 文字 #FFFFFF, フォントは内蔵）。Function `sendChart`（chartFunctions.ts）が `ctx.files` にPNGを push し、Embed の image に `attachment://chart.png` を設定。
- `ctx.richReplyEnabled === false` のとき、リッチ系ハンドラは何もせず `{success:false, message:"ユーザー設定によりリッチ返信は無効です。テキストで返答してください。"}` を返す。

## 7. マクロ（§3.6）= Playbook 統合方針

仕様の「マクロ」は既存 Playbook 機構で実現する（名称はユーザー向けに「マクロ（Playbook）」と案内）。
- 説明ベース登録: 既存 `savePlaybook`。
- 実行ベース登録: `src/services/actionRecorder.ts` が Redis `fc_history:{userId}`（直近30件、TTL 2h）に Function Call 名+引数要約を記録（gemini.ts が dispatch 毎に記録）。**認証情報系・記録系自身は記録から除外**。新Function `saveMacroFromRecentActions` が履歴を取得しLLM向けに返し、LLMが steps へ要約して `savePlaybook` を呼ぶ。
- 呼び出し: `findPlaybooks` でマッチ→LLMがユーザーへ実行確認→承認後 `runPlaybook(name)`（playbookFunctions.ts。steps を返しLLMがその手順に従って実行する既存方式）。
- 定期実行: 既存 playbook_schedules を継続（user_id スコープ化）。

## 8. パスワードマネージャ（§6）とブラウザの調和

`src/functions/credentialFunctions.ts` を以下のFunction群に置き換える:
| Function | 動作 |
|---|---|
| `listCredentialServices` | サービス名+ユーザー名一覧（パスワードなし） |
| `addCredential` | 登録（LLMはユーザーから値を受領した直後のみ呼ぶ。確認フロー必須の旨をdescriptionに明記） |
| `updateCredential` / `deleteCredential` | 同上 |
| `browserFillCredential` | **{service_name, username_selector?, password_selector?}** を受け、復号した値を `browserService.browserInteractiveType` で直接入力。セレクタ省略時はページ内の `input[type=password]` と直前のtext/email inputを自動検出。戻り値は success/message のみ。 |
旧 `getCredential`（平文返却）は**廃止**。全アクセスは `auditRepo.addAuditLog()` に記録（パスワード本体は記録しない）。

## 9. cron系サービス共通

- node-cron でジョブ登録、`cron-parser` で次回実行時刻計算。
- 通知送信は `src/services/notifier.ts`（基盤提供）: `sendToUser(userId, payload: {content?, embeds?, files?}, target?: {type:"dm"|"channel", id})` — ユーザー設定の既定送信先 or 指定先へ、`getBotClientForUser` で解決したクライアントから送信。
- 停止からの復帰: reminders は `trigger_at <= now AND status='pending'` を起動時に処理（仕様§10）。

## 10. ファイル所有マップ（並列実装時の競合防止）

各モジュールは「所有ファイル」以外を**編集禁止**（読むのは自由）。共有ファイル（gemini.ts, bot.ts, index.ts, server.ts, functions/index.ts, public/*）は統合フェーズでのみ編集する。

| モジュール | 所有ファイル |
|---|---|
| 基盤(完了) | types/contracts.ts, db/migrations.ts, db/database.ts, utils/crypto.ts, config.ts, db/auditRepo.ts, services/llmClient.ts, services/notifier.ts, server/routeRegistry.ts, functions/registry.ts |
| auth | services/sessionService.ts, services/passwordPolicy.ts, services/pendingRegistration.ts, db/userRepo.ts, server/routes/authRoutes.ts, server/routes/settingsRoutes.ts |
| messagelog | db/messageLogRepo.ts, functions/conversationFunctions.ts |
| todo | db/todoRepo.ts, functions/todoFunctions.ts, services/autoTagService.ts, server/routes/todoRoutes.ts |
| reminder | db/reminderRepo.ts, services/reminderEngine.ts, functions/reminderFunctions.ts, server/routes/reminderRoutes.ts |
| finance | db/expenseRepo.ts, db/plannedPaymentRepo.ts, functions/financeFunctions.ts, services/paymentRecurrenceService.ts, services/receiptParser.ts, server/routes/financeRoutes.ts |
| pwmanager | db/credentialRepo.ts, db/credentialAccessRepo.ts, services/secretService.ts, functions/credentialFunctions.ts, server/routes/credentialRoutes.ts |
| personal | db/contextNoteRepo.ts, db/clipboardRepo.ts, db/contactRepo.ts, functions/noteFunctions.ts, functions/clipboardFunctions.ts, functions/contactFunctions.ts, services/clipboardCleanupService.ts, services/birthdayReminderService.ts, server/routes/personalRoutes.ts |
| macro | services/playbookService.ts, services/actionRecorder.ts, functions/playbookFunctions.ts, services/playbookScheduleService.ts, server/routes/playbookRoutes.ts |
| reports | db/reportConfigRepo.ts, db/briefingConfigRepo.ts, services/reportService.ts, services/briefingService.ts, functions/briefingFunctions.ts, server/routes/deliveryRoutes.ts |
| webhook | db/webhookRepo.ts, services/webhookProcessor.ts, server/routes/webhookRoutes.ts |
| mcp | db/mcpRepo.ts, services/mcpClient.ts, functions/mcpDynamic.ts, server/routes/mcpRoutes.ts |
| persona | db/personaRepo.ts, server/routes/personaRoutes.ts |
| botattributes（Bot属性 docs/spec/bot_attributes_requirements.md） | services/botCapabilities.ts, services/botRateLimit.ts, db/botAttributesRepo.ts, db/botNoteRepo.ts, functions/botAssistantFunctions.ts, server/routes/botAttributeRoutes.ts |
| charts | services/chartService.ts, functions/chartFunctions.ts |
| calendar | services/googleCalendarService.ts, services/googleDriveService.ts, services/backupService.ts, db/scheduleRepo.ts, db/googleAccountRepo.ts, functions/scheduleFunctions.ts, server/routes/scheduleRoutes.ts |
| 統合 | gemini.ts, bot.ts, index.ts, server.ts, functions/index.ts, db/botRepo.ts, db/inviteRepo.ts, db/systemSettingsRepo.ts, db/database.ts, db/redis.ts, utils/embeds.ts, server/routes/botRoutes.ts（Bot管理）, server/routes/integratedRoutes.ts（統合管理: Bot起動/停止/再起動・リソース許可・Google複数アカウント）, server/routes/adminRoutes.ts, public/* |

## 11. Function 命名規約（最終レジストリ）

既存名は維持しユーザー体験の互換を保つ。新規は lowerCamelCase。最終的に functions/index.ts（統合フェーズ）が各モジュールの `FunctionModule` をマージする。名前衝突禁止。各モジュールの declarations の description は日本語で、LLMが適切に使い分けられるよう具体的に書く（既存ファイルの書きぶりを踏襲）。

## 12. HTTPルート規約

- 新機能のルートは `src/server/routes/*.ts` に `RouteDef[]` を export し、`server/routeRegistry.ts` の `registerRoutes()` で登録する。server.ts はリクエスト毎にまずレジストリを照合する（統合フェーズで接続）。
- 認可: `auth:"user"` はセッション必須。リソースは必ず `ctx.user.discordId` でスコープする。`auth:"admin"` は role 確認。
- Webhook受信 `POST /hook/:token` のみ `auth:"none"`。
