<!-- STUB: 実装は担当エージェントが差し替え（骨格はルーター担当が全タブ配線済み） -->
<script lang="ts">
	// §8 /bot/<tab> の骨格シェル。サイドバー + ヘッダ + 現タブコンポーネント。
	//
	// 重要: このシェルは「タブ→コンポーネントの完全網羅マッピング」を持ち、
	//       各 Bot*.svelte スタブへ配線済み。後続担当は BotShell/App/router を
	//       触らず、各タブファイル（routes/Bot*.svelte）だけ差し替えればよい。
	//
	// タブ切替は navigateTo('/bot/<tab>')。表示中タブは resolveRoute の tab を受ける。
	import type { Component } from "svelte";
	import { derived } from "svelte/store";
	import { activeBot } from "$lib/stores/activeBot";
	import { navigateTo, type BotTab } from "$lib/router";

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

	// §8 タブ → コンポーネント 完全網羅マップ。
	// 各タブは props 形状が異なり得る（例: BotTasks は自前で state を持ち props 無し）ため、
	// 異種コンポーネントを1マップに束ねられるよう Component<Record<string, never>> で受ける。
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

	// §8 プリセット別タブフィルタ。
	// 秘書プリセット専用（汎用モードでは非表示）。
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
	// 汎用モード(mcp_assistant)専用（秘書モードでは非表示）。
	const ASSISTANT_ONLY_TABS: BotTab[] = ["discord"];

	// 全メニュー項目（表示順）。ラベルは日本語。
	const ALL_MENU: { tab: BotTab; label: string; icon: string }[] = [
		{ tab: "dashboard", label: "ダッシュボード", icon: "dashboard" },
		{ tab: "tasks", label: "タスク", icon: "task_alt" },
		{ tab: "timeline", label: "タイムライン", icon: "timeline" },
		{ tab: "schedules", label: "スケジュール", icon: "event" },
		{ tab: "expenses", label: "経費", icon: "payments" },
		{ tab: "reminders", label: "リマインダー", icon: "notifications" },
		{ tab: "personal", label: "パーソナル", icon: "person" },
		{ tab: "personas", label: "ペルソナ", icon: "theater_comedy" },
		{ tab: "delivery", label: "配信", icon: "send" },
		{ tab: "webhooks", label: "Webhook", icon: "webhook" },
		{ tab: "mcp", label: "MCP", icon: "hub" },
		{ tab: "playbooks", label: "プレイブック", icon: "menu_book" },
		{ tab: "discord", label: "Discord", icon: "forum" },
		{ tab: "config", label: "設定", icon: "settings" },
		{ tab: "devices", label: "デバイス", icon: "devices" },
	];

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

	// 現タブに対応するコンポーネント（未知は config フォールバックは router 側で解決済み）。
	const Current = $derived(TAB_COMPONENTS[tab] ?? BotConfig);
</script>

<div class="app-container" id="app-container">
	<aside class="sidebar">
		<div class="sidebar-brand">
			<span class="sidebar-app-name">{$activeBot?.name ?? "システムデフォルト"}</span>
		</div>
		<nav class="sidebar-nav">
			{#each $menuItems as item (item.tab)}
				<button
					type="button"
					class="menu-item"
					class:active={item.tab === tab}
					data-tab={item.tab}
					onclick={() => go(item.tab)}
				>
					<span class="material-symbols-outlined">{item.icon}</span>
					<span>{item.label}</span>
				</button>
			{/each}
		</nav>
	</aside>

	<main class="bot-main">
		<header class="bot-header">
			<!-- STUB: ヘッダ（テーマトグル/ユーザーメニュー等）は担当が本実装 -->
		</header>
		<div class="bot-content">
			<Current />
		</div>
	</main>
</div>
