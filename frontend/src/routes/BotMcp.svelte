<script lang="ts">
	// ─────────────────────────────────────────────────────────────────────────
	// MCP タブ（旧 app.js: fetchMcpServersList / renderMcpServers / openMcpDashboard +
	// index.html #tab-mcp）。登録・削除・Bot別許可は「Bot統合管理」に集約済みのため、
	// ここは状況確認（＋Tool再取得 / 有効無効 / 削除 / 管理ページ）が中心。
	//
	// 書換方針:
	//   - createElement/innerHTML の手組みカード → {#each} + Button/TagChip。
	//   - 管理ページは iframe（sandbox="allow-scripts allow-forms"）モーダル。
	//     iframe は McpDashboardModal 側で bind:this + teardown（onDestroy/close で src 破棄）。
	//   - confirm/alert → confirmDialog/pushToast。
	//
	// ※ P4 で iframe 単独検証要（dev の Vite 前段でダッシュボード iframe が期待どおり動くかは未確定）。
	// ─────────────────────────────────────────────────────────────────────────
	import { mcpApi } from "$lib/api/services";
	import { ApiError } from "$lib/api/client";
	import { pushToast } from "$lib/stores/toast";
	import { confirmDialog } from "$lib/components/ui";
	import { Button, Icon, TagChip, EmptyState } from "$lib/components/ui";
	import { activeBot } from "$lib/stores/activeBot";
	import type { McpServerView } from "$lib/api/types";

	import McpDashboardModal from "./mcp/McpDashboardModal.svelte";

	let servers = $state<McpServerView[]>([]);
	let dashAvailable = $state<Record<number, boolean>>({});
	let loading = $state(false);

	let dashOpen = $state(false);
	let dashServer = $state<{ id: number; name: string } | null>(null);

	// 現在の Bot 表示ラベル（旧 mcp-current-bot-label）。
	const currentBotLabel = $derived(
		$activeBot && $activeBot.id !== "system_default" && $activeBot.name
			? `現在のBot: ${$activeBot.name}`
			: "現在のBot: 既定の秘書（早瀬ユウカ）",
	);

	function reportError(e: unknown) {
		pushToast(e instanceof ApiError ? e.message : "エラーが発生しました", "error");
	}

	async function load() {
		loading = true;
		try {
			const res = await mcpApi.list();
			servers = res.servers ?? [];
			void probeDashboards();
		} catch (e) {
			reportError(e);
			servers = [];
		} finally {
			loading = false;
		}
	}

	async function probeDashboards() {
		const next: Record<number, boolean> = {};
		await Promise.all(
			servers.map(async (s) => {
				try {
					const r = await mcpApi.dashboardStatus(s.id);
					next[s.id] = r.available === true;
				} catch {
					next[s.id] = false;
				}
			}),
		);
		dashAvailable = next;
	}

	// MCP サーバはユーザースコープだが、UI は Bot 画面内なので activeBot 切替でも再取得しておく。
	$effect(() => {
		void $activeBot?.id;
		void load();
	});

	async function refresh(s: McpServerView) {
		try {
			const res = await mcpApi.refresh(s.id);
			pushToast(res.message || "更新しました。", "success");
			await load();
		} catch (e) {
			reportError(e);
		}
	}
	async function toggle(s: McpServerView) {
		try {
			await mcpApi.toggle({ id: s.id, enabled: !s.enabled });
			await load();
		} catch (e) {
			reportError(e);
		}
	}
	async function remove(s: McpServerView) {
		const ok = await confirmDialog({
			message: `MCPサーバー「${s.name}」を削除しますか？`,
			danger: true,
			confirmLabel: "削除",
		});
		if (!ok) return;
		try {
			await mcpApi.delete(s.id);
			await load();
		} catch (e) {
			reportError(e);
		}
	}
	function openDashboard(s: McpServerView) {
		dashServer = { id: s.id, name: s.name };
		dashOpen = true;
	}
</script>

<section class="tab-view">
	<p class="description-text mcp-bot-label">{currentBotLabel}</p>

	<div class="card mcp-note-card">
		<span class="field-sub"
			>MCPサーバーの登録・削除・Bot別の利用許可は「Bot統合管理」ページに集約しました（ここは状況確認のみ）。</span
		>
		<a href="/integrated" class="btn btn-secondary btn-sm">Bot統合管理へ</a>
	</div>

	<div class="action-column card">
		<div class="column-header">
			<h3><Icon name="extension" class="header-icon-symbol" />登録済みMCPサーバー</h3>
		</div>
		<div class="mcp-servers-list">
			{#if servers.length > 0}
				{#each servers as s (s.id)}
					<div class="card-item glass mcp-card">
						<div class="mcp-card-head">
							<span class="card-title mcp-card-title">{s.name}</span>
							<span class="badge badge-accent mcp-scope-badge"
								>{s.scope === "system" ? "システム" : "ユーザー"}</span
							>
							<span class="status-badge {s.enabled ? 'status-sent' : 'status-cancelled'}"
								>{s.enabled ? "有効" : "無効"}</span
							>
							{#if s.requires_confirmation}
								<span class="status-badge status-pending">実行前確認</span>
							{/if}
						</div>
						<div class="mcp-endpoint" title={s.endpoint_url}>
							{s.endpoint_url}{s.has_auth ? " 🔑" : ""}
						</div>
						<div class="mcp-tools">
							{#if s.tools && s.tools.length > 0}
								{#each s.tools as tool (tool.name)}
									<TagChip label={tool.name} class="mcp-tool" />
								{/each}
							{:else}
								<span class="mcp-tools-empty"
									>Tool未取得（「再取得」をお試しください）</span
								>
							{/if}
						</div>
						<div class="mcp-actions">
							<Button variant="secondary" small onclick={() => refresh(s)}>Tool再取得</Button>
							<Button variant={s.enabled ? "secondary" : "primary"} small onclick={() => toggle(s)}
								>{s.enabled ? "無効化" : "有効化"}</Button
							>
							{#if dashAvailable[s.id]}
								<Button variant="secondary" small onclick={() => openDashboard(s)}
									>管理ページ</Button
								>
							{/if}
							<Button variant="secondary" small onclick={() => remove(s)}>削除</Button>
						</div>
					</div>
				{/each}
			{:else if !loading}
				<EmptyState icon="extension" message="登録済みのMCPサーバーがありません。" />
			{/if}
		</div>
	</div>
</section>

<McpDashboardModal bind:open={dashOpen} server={dashServer} />

<style>
	.mcp-bot-label {
		margin-bottom: 12px;
		font-size: 0.85rem;
	}
	.mcp-note-card {
		margin-bottom: 16px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}
	.mcp-servers-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
		max-height: 600px;
		overflow-y: auto;
		padding-right: 4px;
		margin-top: 12px;
	}
	.mcp-card {
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		padding: 14px 16px;
	}
	.mcp-card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.mcp-card-title {
		font-size: 0.95rem;
	}
	.mcp-scope-badge {
		font-size: 0.65rem;
	}
	.mcp-endpoint {
		font-size: 0.78rem;
		font-family: var(--font-family-mono);
		color: var(--color-zinc-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.mcp-tools {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.mcp-tools-empty {
		font-size: 0.75rem;
		color: var(--color-zinc-muted);
	}
	.mcp-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 4px;
	}
</style>
