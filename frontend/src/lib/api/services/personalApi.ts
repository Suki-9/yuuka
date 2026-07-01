// personalApi — bot-scoped（scope:'bot'）。src/server/routes/personalRoutes.ts に対応。
// context-note / clipboard / contacts（personal タブは3本 fetch）。
import { api } from "../client";
import type {
	ContextNoteResponse,
	ClipboardResponse,
	ContactsResponse,
	ApiResponse,
} from "../types";

const BOT = { scope: "bot" } as const;

export const personalApi = {
	// ── コンテキストノート ──
	/** GET /api/context-note */
	getContextNote: () => api.get<ContextNoteResponse>("/api/context-note", BOT),
	/** POST /api/context-note */
	saveContextNote: (note: string) =>
		api.post<ApiResponse>("/api/context-note", { note }, BOT),

	// ── クリップボード ──
	/** GET /api/clipboard */
	clipboard: () => api.get<ClipboardResponse>("/api/clipboard", BOT),
	/** POST /api/clipboard/delete */
	deleteClipboard: (id: number) =>
		api.post<ApiResponse>("/api/clipboard/delete", { id }, BOT),

	// ── 連絡先 ──
	/** GET /api/contacts */
	contacts: () => api.get<ContactsResponse>("/api/contacts", BOT),
	/** POST /api/contacts/save */
	saveContact: (body: {
		id?: number;
		name: string;
		birthday?: string;
		relationship?: string;
		contact_info?: string;
		notes?: string;
		tags?: string[];
	}) => api.post<ApiResponse>("/api/contacts/save", body, BOT),
	/** POST /api/contacts/delete */
	deleteContact: (id: number) =>
		api.post<ApiResponse>("/api/contacts/delete", { id }, BOT),
};
