import { mount } from "svelte";
import { registerSW } from "virtual:pwa-register";
import App from "./App.svelte";
import "./styles.css";

// Service Worker 登録（P1a: vite-plugin-pwa / Workbox generateSW）。
// virtual:pwa-register は Vite バンドルに含まれる 'self' 由来 module のため CSP 適合（inline script なし）。
// 更新戦略は vite.config.ts の registerType:"autoUpdate" に一任（skipWaiting/clientsClaim は明示しない）。
// 旧 src/public/sw.js（yuuka-v10）は参照せず、新 sw.js が cleanupOutdatedCaches で旧キャッシュを掃除する。
registerSW({ immediate: true });

const target = document.getElementById("app");
if (!target) throw new Error("#app mount target not found");

const app = mount(App, { target });

export default app;
