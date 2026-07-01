<script lang="ts">
	// ─────────────────────────────────────────────────────────────────────────
	// LazyView — ルート/オーバーレイの遅延ロード用薄いラッパ（§P1b）。
	//
	// loader（() => import("...")）を prop で受け、内部で $derived(loader()) して
	// {#await} で解決する。Promise 生成を1箇所（この $derived）に束ねることで、
	//   - App.svelte の分岐肥大化を防ぐ（各分岐が <LazyView loader={...}/> 1行）
	//   - ブロック再 mount のたびに loader() が呼ばれても $derived が同一 loader 参照の
	//     間は Promise を安定化させ、責務を集約する（実 fetch は Vite の module cache で
	//     1回に収束）
	// を実現する。Svelte5 の動的コンポーネント構文（{@const V = m.default}<V />）を使う。
	// ─────────────────────────────────────────────────────────────────────────
	import type { Component } from "svelte";

	type Loader = () => Promise<{ default: Component<Record<string, never>> }>;

	let { loader }: { loader: Loader } = $props();

	// loader が変わったときだけ Promise を再生成。同一 loader 参照の再レンダリングでは
	// 同じ Promise 参照のままなので無駄なフェッチが起きない。
	const modulePromise = $derived(loader());
</script>

{#await modulePromise}
	<div class="lazy-loading" aria-busy="true"></div>
{:then module}
	{@const View = module.default}
	<View />
{:catch}
	<div class="lazy-error" role="alert">
		画面の読み込みに失敗しました。再読込してください。
	</div>
{/await}

<style>
	.lazy-loading {
		min-height: 100vh;
	}
	.lazy-error {
		padding: 2rem;
		text-align: center;
	}
</style>
