<script lang="ts">
	// ─────────────────────────────────────────────────────────────────────────
	// BotShell — /bot/<tab> の骨格シェル（旧 index.html #app-container +
	// app.js の switchTab / サイドバー配線 / ヘッダ操作を移植）。
	//
	// 重要（統合契約）: 「タブ名 → Bot*.svelte の対応・<svelte:component> スイッチ」は
	//   完全に維持する。後続タブ担当は routes/Bot*.svelte だけ差し替えればよい。
	//
	// 実装するもの:
	//   - サイドバー（Bot一覧へ戻る / Bot ブランディング / プリセット別メニュー・active）
	//   - ヘッダ（現タブタイトル・Bot切替バッジ・ユーザーバッジ・テーマトグル・ログアウト）
	//   - タブ切替は navigateTo('/bot/<tab>')。表示中タブは props.tab を受ける。
	//   - 秘書/汎用プリセット別タブフィルタ（SECRETARY_ONLY / ASSISTANT_ONLY）。
	// ─────────────────────────────────────────────────────────────────────────
	import type { Component } from "svelte";
	import { derived } from "svelte/store";
	import { activeBot, selectBot } from "$lib/stores/activeBot";
	import { currentUser } from "$lib/stores/session";
	import { theme, toggleTheme } from "$lib/stores/theme";
	import { authApi } from "$lib/api/services";
	import { pushToast } from "$lib/stores/toast";
	import { navigateTo, type BotTab } from "$lib/router";
	import { Icon } from "$lib/components/ui";

	import BotDashboard from "./BotDashboard.svelte";
	import BotTasks from "./BotTasks.svelte";
	import BotTimeline from "./BotTimeline.svelte";
	import BotSchedules from "./BotSchedules.svelte";
	import BotExpenses from "./BotExpenses.svelte";
	import BotReminders from "./BotReminders.svelte";
	import BotPersonal from "./BotPersonal.svelte";
	import BotPersonas from "./BotPersonas.svelte";
	import BotDelivery from "./BotDelivery.svelte";
	import BotWebhooks from "./BotWebhooks.svelte";
	import BotMcp from "./BotMcp.svelte";
	import BotPlaybooks from "./BotPlaybooks.svelte";
	import BotDiscord from "./BotDiscord.svelte";
	import BotConfig from "./BotConfig.svelte";
	import BotDevices from "./BotDevices.svelte";

	// 現在表示中のタブ（App/router から渡される。未指定は既定 config）。
	let { tab = "config" as BotTab }: { tab?: BotTab } = $props();

	// §8 タブ → コンポーネント 完全網羅マップ（統合契約: 不変に保つ）。
	// 各タブは props 形状が異なり得るため Component<Record<string, never>> で受ける。
	const TAB_COMPONENTS: Record<BotTab, Component<Record<string, never>>> = {
		dashboard: BotDashboard,
		tasks: BotTasks,
		timeline: BotTimeline,
		schedules: BotSchedules,
		expenses: BotExpenses,
		reminders: BotReminders,
		personal: BotPersonal,
		personas: BotPersonas,
		delivery: BotDelivery,
		webhooks: BotWebhooks,
		mcp: BotMcp,
		playbooks: BotPlaybooks,
		discord: BotDiscord,
		config: BotConfig,
		devices: BotDevices,
	};

	// §8 プリセット別タブフィルタ（旧 app.js:157-170）。
	const SECRETARY_ONLY_TABS: BotTab[] = [
		"tasks",
		"timeline",
		"schedules",
		"expenses",
		"reminders",
		"personal",
		"delivery",
		"webhooks",
		"playbooks",
	];
	const ASSISTANT_ONLY_TABS: BotTab[] = ["discord"];

	// 全メニュー項目（旧 index.html sidebar-menu の順・ラベル・アイコン）。
	const ALL_MENU: { tab: BotTab; label: string; icon: string }[] = [
		{ tab: "dashboard", label: "一般情報", icon: "info" },
		{ tab: "tasks", label: "タスク管理", icon: "checklist" },
		{ tab: "timeline", label: "タイムライン", icon: "timeline" },
		{ tab: "schedules", label: "予定スケジュール", icon: "calendar_today" },
		{ tab: "expenses", label: "経費・収支管理", icon: "payments" },
		{ tab: "reminders", label: "リマインダー", icon: "alarm" },
		{ tab: "personal", label: "メモ・連絡先", icon: "contacts" },
		{ tab: "personas", label: "ペルソナ", icon: "theater_comedy" },
		{ tab: "delivery", label: "配信設定", icon: "campaign" },
		{ tab: "webhooks", label: "Webhook", icon: "webhook" },
		{ tab: "mcp", label: "MCPサーバー", icon: "extension" },
		{ tab: "playbooks", label: "Playbook 管理", icon: "description" },
		{ tab: "discord", label: "Discord連携", icon: "forum" },
		{ tab: "config", label: "Bot 設定", icon: "smart_toy" },
		{ tab: "devices", label: "接続端末", icon: "devices" },
	];

	// §8 ヘッダタイトルマップ（旧 app.js:338-354 switchTab）。
	const TAB_TITLES: Record<BotTab, string> = {
		dashboard: "ダッシュボード",
		tasks: "タスク管理",
		timeline: "デイリータイムライン",
		schedules: "予定スケジュール",
		expenses: "家計管理",
		reminders: "リマインダー",
		personal: "メモ・連絡先",
		personas: "ペルソナ管理",
		delivery: "配信設定",
		webhooks: "Webhook 連携",
		mcp: "MCPサーバー管理",
		playbooks: "Playbook 設定",
		discord: "Discord 連携設定",
		config: "システム設定情報",
		devices: "接続端末",
	};

	// プリセット別に絞り込んだメニュー配列（derived(activeBot)）。
	const menuItems = derived(activeBot, ($bot) => {
		const isAssistant = ($bot?.preset ?? "secretary") === "mcp_assistant";
		return ALL_MENU.filter((m) => {
			if (SECRETARY_ONLY_TABS.includes(m.tab)) return !isAssistant;
			if (ASSISTANT_ONLY_TABS.includes(m.tab)) return isAssistant;
			return true;
		});
	});

	function go(t: BotTab): void {
		navigateTo(`/bot/${t}`);
	}

	// Bot切替（旧 btn-switch-bot / sidebar-btn-back-bots → navigateTo("/")）。
	function backToBots(): void {
		navigateTo("/");
	}

	// ログアウト（旧 btnLogout: /api/logout → Bot 選択解除 → /login）。
	async function logout(): Promise<void> {
		try {
			await authApi.logout();
		} catch {
			/* ログアウトはローカル状態の破棄を優先。通信失敗でも続行 */
		}
		selectBot(null);
		currentUser.set(null);
		navigateTo("/login");
	}

	// 現タブに対応するコンポーネント（未知は config フォールバック）。
	const Current = $derived(TAB_COMPONENTS[tab] ?? BotConfig);
	const title = $derived(TAB_TITLES[tab] ?? "ダッシュボード");

	// Bot ブランディング（旧 updateSidebarBotBranding）。
	const botName = $derived($activeBot?.name ?? "システムデフォルト");
	const botId = $derived($activeBot?.id ?? "system_default");
	const botIdLabel = $derived(botId.startsWith("bot_") ? botId.slice(4) : botId);
	const botAvatar = $derived($activeBot?.avatar ?? "");
	const DEFAULT_AVATAR =
		"https://assets-global.website-files.com/6257adef93867e50d84d30e2/636e0a6a49cf127bf92de1e2_icon_clyde_blurple_RGB.png";

	// ヘッダのユーザー表示（旧 current-user-display: "username (discordId)"）。
	const userDisplay = $derived(
		$currentUser ? `${$currentUser.username} (${$currentUser.discordId})` : "ロード中...",
	);

	// テーマトグルのアイコン/ツールチップ（旧 applyThemeIcon）。
	const themeIcon = $derived($theme === "dark" ? "light_mode" : "dark_mode");
	const themeTitle = $derived(
		$theme === "dark" ? "ライトテーマに切り替え" : "ダークテーマに切り替え",
	);
</script>

<div class="app-container" id="app-container">
	<aside class="sidebar">
		<button
			type="button"
			class="sidebar-back-button"
			title="Bot一覧に戻る"
			onclick={backToBots}
		>
			<Icon name="chevron_left" />
			<span>アプリケーション一覧</span>
		</button>

		<div class="app-sidebar-header">
			<div class="app-sidebar-avatar-container">
				<img src={botAvatar || DEFAULT_AVATAR} alt="App Icon" />
			</div>
			<div class="app-sidebar-meta">
				<h3>{botName}</h3>
				<span class="app-id-label">APPLICATION ID</span>
				<span class="app-id-value">{botIdLabel}</span>
			</div>
		</div>

		<nav class="sidebar-menu">
			{#each $menuItems as item (item.tab)}
				<button
					type="button"
					class="menu-item"
					class:active={item.tab === tab}
					data-tab={item.tab}
					onclick={() => go(item.tab)}
				>
					<Icon name={item.icon} class="menu-icon-symbol" />
					<span class="menu-text">{item.label}</span>
				</button>
			{/each}
		</nav>
	</aside>

	<main class="main-content">
		<header class="top-header">
			<div class="header-title">
				<h2 id="current-tab-title">{title}</h2>
				<p id="header-subtitle">タスク・スケジュール・家計をスマートに管理します。</p>
			</div>

			<div class="header-controls">
				<button
					type="button"
					class="bot-context-badge"
					title="Botを切り替える"
					onclick={backToBots}
				>
					<Icon name="robot_2" class="icon-small" />
					<span>{botName}</span>
				</button>
				<div class="user-profile-badge">
					<Icon name="person" class="icon-small" />
					<span>{userDisplay}</span>
				</div>
				<button
					type="button"
					class="btn-icon"
					title={themeTitle}
					aria-label={themeTitle}
					onclick={toggleTheme}
				>
					<Icon name={themeIcon} />
				</button>
				<button
					type="button"
					class="btn btn-secondary btn-sm"
					title="ログアウト"
					onclick={logout}
				>
					<Icon name="logout" class="icon-button-left" /> ログアウト
				</button>
			</div>
		</header>

		<div class="content-view-container">
			<Current />
		</div>
	</main>
</div>

<style>
	/* 旧 #app-container の id セレクタ由来レイアウトを維持しつつ、
	   Svelte スコープでも同じ flex レイアウトを保証する。 */
	.app-container {
		display: flex;
		min-height: 100vh;
	}
	.sidebar-back-button {
		background: none;
		border: none;
		cursor: pointer;
		width: 100%;
		text-align: left;
	}
	.menu-item {
		background: none;
		border: none;
		width: 100%;
		cursor: pointer;
		font: inherit;
		text-align: left;
	}
	.bot-context-badge {
		background: none;
		cursor: pointer;
		font: inherit;
	}
	.content-view-container {
		flex: 1;
	}
</style>
