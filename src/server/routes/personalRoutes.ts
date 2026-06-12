import type { RouteDef } from "../../types/contracts.js";
import { sendJson } from "../../types/contracts.js";
import {
  getContextNote,
  setContextNote,
  getContextNoteUpdatedAt,
  CONTEXT_NOTE_MAX_LENGTH,
} from "../../db/contextNoteRepo.js";
import { listEntries, deleteEntry } from "../../db/clipboardRepo.js";
import {
  listContacts,
  addContact,
  updateContact,
  deleteContact,
  getContactById,
  isValidBirthday,
} from "../../db/contactRepo.js";

// ─── コンテキストノート・クリップボード・連絡先 HTTPルート ────────────────────
// 全ルート auth:"user"。リソースは ctx.user.discordId でスコープする（§12）。

export const personalRoutes: RouteDef[] = [
  // ── コンテキストノート（§3.7.3: 管理UIから全体の参照・編集が可能） ──
  {
    method: "GET",
    path: "/api/context-note",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      sendJson(ctx.res, 200, {
        success: true,
        content: getContextNote(userId),
        updated_at: getContextNoteUpdatedAt(userId),
        max_length: CONTEXT_NOTE_MAX_LENGTH,
      });
    },
  },
  {
    method: "POST",
    path: "/api/context-note",
    auth: "user",
    async handler(ctx) {
      const content = typeof ctx.body.content === "string" ? ctx.body.content : "";
      try {
        setContextNote(ctx.user!.discordId, content);
        sendJson(ctx.res, 200, { success: true, message: "コンテキストノートを保存しました。" });
      } catch (err) {
        sendJson(ctx.res, 400, { success: false, message: (err as Error).message });
      }
    },
  },

  // ── クリップボード ──
  {
    method: "GET",
    path: "/api/clipboard",
    auth: "user",
    async handler(ctx) {
      const entries = listEntries(ctx.user!.discordId);
      sendJson(ctx.res, 200, { success: true, entries });
    },
  },
  {
    method: "POST",
    path: "/api/clipboard/delete",
    auth: "user",
    async handler(ctx) {
      const id = Number(ctx.body.id);
      if (!Number.isInteger(id)) {
        return sendJson(ctx.res, 400, { success: false, message: "id は必須です。" });
      }
      const ok = deleteEntry(ctx.user!.discordId, id);
      sendJson(ctx.res, 200, {
        success: ok,
        message: ok ? "メモを削除しました。" : "メモが見つかりません。",
      });
    },
  },

  // ── 連絡先 ──
  {
    method: "GET",
    path: "/api/contacts",
    auth: "user",
    async handler(ctx) {
      const contacts = listContacts(ctx.user!.discordId).map((c) => {
        let tags: string[] = [];
        try {
          tags = JSON.parse(c.tags);
        } catch {}
        return { ...c, tags };
      });
      sendJson(ctx.res, 200, { success: true, contacts });
    },
  },
  {
    method: "POST",
    path: "/api/contacts/save",
    auth: "user",
    async handler(ctx) {
      const userId = ctx.user!.discordId;
      const name = typeof ctx.body.name === "string" ? ctx.body.name.trim() : "";
      if (!name) {
        return sendJson(ctx.res, 400, { success: false, message: "氏名は必須です。" });
      }

      const birthday =
        typeof ctx.body.birthday === "string" && ctx.body.birthday.trim()
          ? ctx.body.birthday.trim()
          : null;
      if (birthday && !isValidBirthday(birthday)) {
        return sendJson(ctx.res, 400, {
          success: false,
          message: "誕生日は YYYY-MM-DD 形式（年不明なら --MM-DD）で指定してください。",
        });
      }

      const input = {
        name,
        birthday,
        relationship:
          typeof ctx.body.relationship === "string" && ctx.body.relationship.trim()
            ? ctx.body.relationship.trim()
            : null,
        contactInfo:
          typeof ctx.body.contactInfo === "string" && ctx.body.contactInfo.trim()
            ? ctx.body.contactInfo.trim()
            : null,
        notes:
          typeof ctx.body.notes === "string" && ctx.body.notes.trim() ? ctx.body.notes.trim() : null,
        tags: Array.isArray(ctx.body.tags) ? (ctx.body.tags as unknown[]).map(String) : [],
      };

      const id = ctx.body.id != null ? Number(ctx.body.id) : null;
      if (id != null && Number.isInteger(id)) {
        // 更新
        if (!getContactById(userId, id)) {
          return sendJson(ctx.res, 404, { success: false, message: "連絡先が見つかりません。" });
        }
        updateContact(userId, id, input);
        sendJson(ctx.res, 200, { success: true, message: `連絡先「${name}」を更新しました。` });
      } else {
        // 新規
        const contact = addContact(userId, input);
        sendJson(ctx.res, 200, { success: true, contact, message: `連絡先「${name}」を登録しました。` });
      }
    },
  },
  {
    method: "POST",
    path: "/api/contacts/delete",
    auth: "user",
    async handler(ctx) {
      const id = Number(ctx.body.id);
      if (!Number.isInteger(id)) {
        return sendJson(ctx.res, 400, { success: false, message: "id は必須です。" });
      }
      const ok = deleteContact(ctx.user!.discordId, id);
      sendJson(ctx.res, 200, {
        success: ok,
        message: ok ? "連絡先を削除しました。" : "連絡先が見つかりません。",
      });
    },
  },
];
