<script lang="ts">
	// ─────────────────────────────────────────────────────────────────────────
	// App.svelte — 本配線（統合担当）
	//
	// 責務:
	//   - ルーター初期化（popstate 1個）+ テーマストア初期化 + bootstrapSession()
	//   - §12.3 theme-no-transition 除去
	//   - §8 ルーティング対応表に従った単一表示ソースの出し分け
	//     （CSS .active との二重管理を避け {#if}/ルーターへ一元化）
	//   - 認証ゲート / admin ガード / Bot 未選択リダイレクト（ルーターに密結合せず
	//     ここで認証ストア購読ガードとして実施 — §8 末尾 / §9）
	//   - Toast / ConfirmDialog をルート直下に常設
	// ─────────────────────────────────────────────────────────────────────────
	import { onMount, onDestroy } from "svelte";

	// theme ストアは import するだけで subscribe 副作用（data-theme/localStorage/
	// meta[theme-color] 同期）が走る設計。
	import "$lib/stores/theme";
	import { isAuthed, isAdmin, bootstrapSession } from "$lib/stores/session";
	import { activeBot } from "$lib/stores/activeBot";
	import {
		page,
		initRouter,
		resolveRoute,
		type ResolvedRoute,
		type RouteView,
	} from "$lib/router";

	// effectiveView は RouteView に「認証保留中」の "loading" を足した表示状態。
	type EffectiveView = RouteView | "loading";

	import { Toast, ConfirmDialog } from "$lib/components/ui";

	// ルート系オーバーレイ/ページ
	import Login from "./overlays/Login.svelte";
	import BotSelection from "./overlays/BotSelection.svelte";
	import IntegratedOverlay from "./overlays/IntegratedOverlay.svelte";
	import AdminOverlay from "./overlays/AdminOverlay.svelte";
	import AccountOverlay from "./overlays/AccountOverlay.svelte";
	import DeviceOverlay from "./overlays/DeviceOverlay.svelte";
	import Usage from "./overlays/Usage.svelte";
	import Terms from "./overlays/Terms.svelte";
	import Privacy from "./overlays/Privacy.svelte";
	import TasksGuide from "./overlays/TasksGuide.svelte";
	import BotShell from "./routes/BotShell.svelte";

	// ── 状態購読 ─────────────────────────────────────────────────────────────
	// currentRoute（cleanPath）と page（URL）は両方 router が更新する。
	// resolveRoute は page（searchParams 保持）を優先入力にする。
	let resolved = $state<ResolvedRoute>(resolveRoute($page));
	let authed = $state(false);
	let admin = $state(false);

	page.subscribe((u) => (resolved = resolveRoute(u)));
	isAuthed.subscribe((v) => (authed = v));
	isAdmin.subscribe((v) => (admin = v));

	// セッションブートストラップ完了フラグ。完了までは認証依存ルートで
	// 未ログインへ即バウンスさせない（/api/me 応答待ち）。
	let bootstrapped = $state(false);

	// ── 認証ゲート付き実効ビュー ─────────────────────────────────────────────
	// §8 対応表を単一の $derived に集約。ここが唯一の表示決定ソース。
	const PUBLIC_VIEWS = new Set(["usage", "terms", "privacy", "tasks-guide"]);

	const effectiveView = $derived.by((): EffectiveView => {
		const v = resolved.view;

		// 公開ルートは認証前でも常に描画。
		if (PUBLIC_VIEWS.has(v)) return v;

		// /device はログイン往復に対応するため、そのまま描画（未ログインでも
		// Login を挟まず承認画面を出し、内部でログイン誘導する設計）。
		if (v === "device") return v;

		// login 画面はゲート対象外。
		if (v === "login") return authed ? "bots" : "login";

		// ここから要ログイン領域。ブートストラップ未完了なら判定を保留（何も出さない）。
		if (!bootstrapped) return "loading";
		if (!authed) return "login";

		// admin ガード: 非 admin は Bot 選択へ。
		if (v === "admin") return admin ? "admin" : "bots";

		// Bot 個別画面: Bot 未選択なら選択画面へ。
		if (v === "bot") return $activeBot ? "bot" : "bots";

		// notfound: ログイン済は Bot 選択へ丸める。
		if (v === "notfound") return "bots";

		// integrated / account / bots はそのまま。
		return v;
	});

	// ── 初期化 ───────────────────────────────────────────────────────────────
	let cleanupRouter: (() => void) | null = null;

	onMount(() => {
		cleanupRouter = initRouter();

		// §12.3: 初回描画確定後にトランジション抑止クラスを外す。
		document.documentElement.classList.remove("theme-no-transition");

		// セッション取得（未ログインは匿名 = currentUser null のまま）。
		void bootstrapSession().finally(() => {
			bootstrapped = true;
		});
	});

	onDestroy(() => {
		cleanupRouter?.();
	});
</script>

<!--
  単一表示ソース: effectiveView（§8 対応表 + 認証ゲート）で一元的に出し分ける。
  CSS の .active クラスによる旧オーバーレイ排他は使わない（§15）。
-->
{#if effectiveView === "loading"}
	<div class="app-boot" aria-busy="true"></div>
{:else if effectiveView === "login"}
	<Login />
{:else if effectiveView === "bots"}
	<BotSelection />
{:else if effectiveView === "bot"}
	<BotShell tab={resolved.tab ?? "config"} />
{:else if effectiveView === "integrated"}
	<IntegratedOverlay />
{:else if effectiveView === "admin"}
	<AdminOverlay />
{:else if effectiveView === "account"}
	<AccountOverlay />
{:else if effectiveView === "device"}
	<DeviceOverlay />
{:else if effectiveView === "usage"}
	<Usage />
{:else if effectiveView === "terms"}
	<Terms />
{:else if effectiveView === "privacy"}
	<Privacy />
{:else if effectiveView === "tasks-guide"}
	<TasksGuide />
{/if}

<!-- ルート直下に一度だけ常設（alert()/confirm() 置換） -->
<Toast />
<ConfirmDialog />

<style>
	.app-boot {
		min-height: 100vh;
	}
</style>
