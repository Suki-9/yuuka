import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

// Service Worker 登録は P1 (vite-plugin-pwa) で行う。旧 src/public/sw.js は参照しない。
const target = document.getElementById("app");
if (!target) throw new Error("#app mount target not found");

const app = mount(App, { target });

export default app;
