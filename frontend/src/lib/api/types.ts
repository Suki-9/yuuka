// ─────────────────────────────────────────────────────────────────────────────
// 共通 API 型定義（型付き API クライアント層）
//
// - サーバの大半のレスポンスは { success: boolean; message?: string } & payload
//   の「トップレベル直置き」形状（`data` ラッパは無い）。→ ApiResponse<T> で表現。
// - 機密列（*_encrypted / *_iv / *_tag・password_hash・salt 等）は zod ビュー
//   スキーマ（src/types/apiViews.ts）で strip 済みのため、ここでも露出フィールド
//   のみを型化する。全網羅ではなく、フロントが参照する主要フィールドを厚めに定義。
// - 参照元: src/server/routes/*.ts, src/db/*Repo.ts, src/types/apiViews.ts
// ─────────────────────────────────────────────────────────────────────────────

/** 共通エンベロープ。ペイロードはトップレベル直置き（`data` ラッパ不在）。 */
export type ApiResponse<T = unknown> = { success: boolean; message?: string } & T;

// ─── auth / session ──────────────────────────────────────────────────────────

export interface SessionUser {
	discordId: string;
	username: string;
	role: "user" | "admin";
}

/** GET /api/me */
export type MeResponse = ApiResponse<{
	user: SessionUser;
	termsUrl?: string;
	privacyUrl?: string;
	usageUrl?: string;
}>;

/** GET /api/setup/status（共通エンベロープの例外: success を持たない） */
export interface SetupStatusResponse {
	needSetup: boolean;
	termsUrl?: string;
	privacyUrl?: string;
	usageUrl?: string;
}

/** POST /api/login */
export type LoginResponse = ApiResponse<{ user?: SessionUser }>;

/**
 * POST /api/register（DM チャレンジ発行 → /api/register/verify で確定）。
 * サーバは本人確認のため常に pending:true を返す（authRoutes.ts:282）。
 */
export type RegisterResponse = ApiResponse<{ pending?: boolean }>;

// ─── bots ────────────────────────────────────────────────────────────────────

/** botViewSchema（src/types/apiViews.ts）。機密トークン/APIキー暗号文は含まれない。 */
export interface BotView {
	id: string;
	user_id: string;
	name: string;
	recommended_persona_id: number | null;
	persona_id: number | null;
	capabilities: string;
	discord_username: string | null;
	discord_avatar_url: string | null;
	discord_application_id: string | null;
	suspended: number;
	created_at: string;
	updated_at: string;
	preset: string;
	preset_display_name: string;
	has_gemini_key: boolean;
	has_token: boolean;
	running: boolean;
	connected: boolean;
	shared: boolean;
}

export type BotListResponse = ApiResponse<{ bots: BotView[] }>;
export type BotResponse = ApiResponse<{ bot: BotView }>;

export interface PresetOption {
	preset: string;
	display_name: string;
	description?: string;
}
export type PresetsResponse = ApiResponse<{ presets: PresetOption[] }>;

export interface BotShareView {
	bot_id: string;
	grantee_id: string;
	grantee_username?: string;
	created_at?: string;
}
export type BotSharesResponse = ApiResponse<{ shares: BotShareView[] }>;

/** GET /api/bots/usage（呼び出し側が手動で botId を query 付与する: scope:'user'） */
export type BotUsageResponse = ApiResponse<{
	usage?: Record<string, unknown>;
}>;

// ─── tasks（todoRepo） ────────────────────────────────────────────────────────

export type TodoPriority = "high" | "medium" | "low";

export interface TodoRecord {
	id: number;
	user_id: string;
	bot_id: string;
	title: string;
	description: string | null;
	due_date: string | null;
	start_date: string | null;
	priority: TodoPriority | null;
	tags: string;
	status: "open" | "done";
	progress: number;
	parent_id: number | null;
	linked_payment_id: number | null;
	due_reminded: number;
	repeat_rule: string | null;
	repeat_until: string | null;
	repeat_count: number | null;
	created_at: string;
	updated_at: string;
}

export interface TodoWithSubtasks extends TodoRecord {
	subtasks: TodoWithSubtasks[];
	effective_progress: number;
}

export interface TaskProgressLogRecord {
	id: number;
	user_id: string;
	bot_id: string;
	todo_id: number;
	progress: number;
	note: string | null;
	created_at: string;
}

export interface TagCount {
	tag: string;
	count: number;
}

export type TasksResponse = ApiResponse<{ tasks: TodoWithSubtasks[]; tags?: TagCount[] }>;
export type TaskDetailResponse = ApiResponse<{
	task: TodoWithSubtasks;
	progressLogs?: TaskProgressLogRecord[];
}>;
export type TaskGanttResponse = ApiResponse<{ tasks: TodoWithSubtasks[] }>;

// ─── expenses（expenseRepo / plannedPaymentRepo） ─────────────────────────────

export type ExpenseType = "income" | "expense";

export interface ExpenseRecord {
	id: number;
	user_id: string;
	bot_id: string;
	type: ExpenseType;
	amount: number;
	category: string;
	memo: string | null;
	date: string;
	time: string | null;
	source: string;
	created_at: string;
}

export interface CategoryTotal {
	category: string;
	total: number;
	count: number;
}

export interface MonthlyTrendPoint {
	month: string;
	income: number;
	expense: number;
}

export interface BudgetLimit {
	id?: number;
	category: string;
	monthly_limit: number;
}

export interface PlannedPayment {
	id: number;
	title: string;
	amount: number;
	due_date: string;
	category?: string | null;
	paid?: number;
}

export type ExpensesResponse = ApiResponse<{
	expenses: ExpenseRecord[];
	breakdown?: CategoryTotal[];
	trend?: MonthlyTrendPoint[];
}>;
export type BudgetLimitsResponse = ApiResponse<{ limits: BudgetLimit[] }>;
export type PlannedPaymentsResponse = ApiResponse<{ plans: PlannedPayment[] }>;

// ─── schedules（scheduleRepo） ───────────────────────────────────────────────

export interface ScheduleRecord {
	id: number;
	user_id: string;
	bot_id: string;
	title: string;
	description: string | null;
	start_at: string;
	end_at: string | null;
	remind_before_minutes: number;
	reminded: number;
	google_event_id: string | null;
	google_calendar_id: string | null;
	created_at: string;
}
export type SchedulesResponse = ApiResponse<{ schedules: ScheduleRecord[] }>;

// ─── reminders（reminderRepo） ───────────────────────────────────────────────

export type ReminderTargetType = "dm" | "channel";
export type ReminderStatus = "pending" | "sent" | "cancelled";

export interface ReminderRecord {
	id: number;
	user_id: string;
	bot_id: string;
	message: string;
	trigger_at: string;
	repeat_rule: string | null;
	target_type: ReminderTargetType;
	target_id: string | null;
	status: ReminderStatus;
	source: string;
	source_id: string | null;
	created_at: string;
}
export type RemindersResponse = ApiResponse<{ reminders: ReminderRecord[] }>;

// ─── timeline（timelineRepo） ────────────────────────────────────────────────

export type PlanBlockType = "task" | "transit" | "event" | "free";
export type RecordType = "memo" | "expense" | "task_done" | "media" | "location";

export interface DayPlanBlock {
	id: number;
	user_id: string;
	bot_id: string;
	date: string;
	start_time: string | null;
	end_time: string | null;
	type: PlanBlockType;
	title: string;
	description: string | null;
	todo_id: number | null;
	transit_from: string | null;
	transit_to: string | null;
	transit_line: string | null;
	position: number;
	created_at: string;
	updated_at: string;
}

export interface TimelineRecord {
	id: number;
	user_id: string;
	bot_id: string;
	date: string;
	recorded_at: string;
	type: RecordType;
	title: string | null;
	content: string | null;
	todo_id: number | null;
	expense_id: number | null;
	amount: number | null;
	expense_category: string | null;
	media_path: string | null;
	media_type: string | null;
	location: string | null;
	created_at: string;
}

// 注: サーバ（timelineRoutes.ts /api/timeline/day）は `blocks` キーで返す（`plan` ではない）。
export type TimelineDayResponse = ApiResponse<{
	blocks: DayPlanBlock[];
	records: TimelineRecord[];
}>;

// ─── personal（contextNote / clipboard / contacts） ──────────────────────────

export interface ContactView {
	id: number;
	name: string;
	birthday: string | null;
	relationship: string | null;
	contact_info: string | null;
	notes: string | null;
	tags: string[];
	created_at: string;
	updated_at: string;
}
export type ContactsResponse = ApiResponse<{ contacts: ContactView[] }>;

export interface ClipboardItem {
	id: number;
	content: string;
	created_at: string;
}
export type ClipboardResponse = ApiResponse<{ items: ClipboardItem[] }>;

export type ContextNoteResponse = ApiResponse<{ note: string }>;

// ─── personas（personaRepo） ─────────────────────────────────────────────────

export interface PersonaRecord {
	id: number;
	owner_id: string;
	name: string;
	prompt: string;
	is_public: number;
	created_at: string;
	updated_at: string;
}

export interface PublicPersonaView {
	id: number;
	name: string;
	prompt_preview: string;
	prompt_length: number;
	owner_username: string;
	updated_at: string;
}

export type PersonasResponse = ApiResponse<{ personas: PersonaRecord[] }>;
export type PersonaMarketplaceResponse = ApiResponse<{ personas: PublicPersonaView[] }>;

// ─── playbooks（playbookRepo） ───────────────────────────────────────────────

export interface PlaybookRecord {
	id: number;
	name: string;
	content?: string;
	created_at?: string;
	updated_at?: string;
}
export interface PlaybookScheduleRecord {
	id: number;
	playbook_id: number;
	cron: string;
	enabled: number;
}
export interface PlaybookRunRecord {
	id: number;
	playbook_id: number;
	status: string;
	started_at?: string;
	finished_at?: string | null;
}
export type PlaybooksResponse = ApiResponse<{ playbooks: PlaybookRecord[] }>;
export type PlaybookSchedulesResponse = ApiResponse<{ schedules: PlaybookScheduleRecord[] }>;
export type PlaybookRunsResponse = ApiResponse<{ runs: PlaybookRunRecord[] }>;

// ─── webhooks（webhookRepo） ─────────────────────────────────────────────────

export interface WebhookEndpointView {
	id: number;
	name: string;
	token: string;
	has_secret: boolean;
	notify_target_type: "dm" | "channel";
	notify_target_id: string | null;
	template: string | null;
	filter_keyword: string | null;
	create_todo: boolean;
	create_reminder: boolean;
	enabled: boolean;
	created_at: string;
}
export interface WebhookDeliveryRecord {
	id: number;
	endpoint_id: number;
	status: string;
	created_at: string;
}
export type WebhooksResponse = ApiResponse<{ webhooks: WebhookEndpointView[] }>;
export type WebhookDeliveriesResponse = ApiResponse<{ deliveries: WebhookDeliveryRecord[] }>;

// ─── mcp（mcpRepo） ──────────────────────────────────────────────────────────

export interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: unknown;
}
export interface McpServerView {
	id: number;
	name: string;
	endpoint_url: string;
	requires_confirmation: number;
	enabled: number;
	tools_cache_updated: string | null;
	created_at: string;
}
export type McpServersResponse = ApiResponse<{ servers: McpServerView[] }>;

// ─── credentials（credentialRepo） ───────────────────────────────────────────

export interface CredentialView {
	id: number;
	name: string;
	type?: string;
	created_at: string;
}
export type CredentialsResponse = ApiResponse<{ credentials: CredentialView[] }>;

// ─── delivery（briefingConfig / reportConfig） ───────────────────────────────

export interface BriefingConfig {
	enabled?: boolean;
	time?: string;
	[k: string]: unknown;
}
export type BriefingConfigResponse = ApiResponse<{ config: BriefingConfig }>;

export interface ReportConfig {
	id: number;
	type?: string;
	cron?: string;
	enabled?: boolean;
	[k: string]: unknown;
}
export type ReportConfigsResponse = ApiResponse<{ configs: ReportConfig[] }>;

// ─── settings（userRepo / status / discord / google） ────────────────────────

export type StatusResponse = ApiResponse<{ [k: string]: unknown }>;
export type DiscordSettingsResponse = ApiResponse<{ [k: string]: unknown }>;
export type GoogleOAuthUrlResponse = ApiResponse<{ url: string }>;

// ─── integrated ──────────────────────────────────────────────────────────────

export type IntegratedOverviewResponse = ApiResponse<{ [k: string]: unknown }>;

// ─── admin（adminRoutes） ────────────────────────────────────────────────────

export interface AdminUserView {
	discord_id: string;
	username: string;
	role: string;
	created_at: string;
	updated_at: string;
}
export interface AdminStats {
	[k: string]: unknown;
}
export type AdminBotView = BotView;
export interface InviteCode {
	code: string;
	created_at: string;
	used_by?: string | null;
	revoked?: boolean;
}
export interface AuditLogEntry {
	id: number;
	actor?: string;
	action: string;
	created_at: string;
	[k: string]: unknown;
}
export type AdminStatsResponse = ApiResponse<{ stats: AdminStats }>;
export type AdminUsersResponse = ApiResponse<{ users: AdminUserView[] }>;
export type AdminBotsResponse = ApiResponse<{ bots: AdminBotView[] }>;
export type AdminInviteCodesResponse = ApiResponse<{ codes: InviteCode[] }>;
export type AdminAuditLogsResponse = ApiResponse<{ logs: AuditLogEntry[] }>;
export type AdminSystemSettingsResponse = ApiResponse<{ settings: Record<string, unknown> }>;

// ─── devices（deviceMgmtRoutes） ─────────────────────────────────────────────

export interface DeviceRecord {
	id: string;
	name: string;
	created_at: string;
	last_used_at?: string | null;
}
export type DevicesResponse = ApiResponse<{ devices: DeviceRecord[] }>;

// ─── device auth (OAuth device flow) ─────────────────────────────────────────

/** POST /api/auth/device/code のレスポンス（OAuth device authorization 形状） */
export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval: number;
}

/** deviceApi.pollToken の戻り（§10.4。汎用 request を通さない専用形状） */
export type PollResult =
	| { status: "authorized"; token: string }
	| { status: "pending"; slowDown: boolean }
	| { status: "error"; code: string };
