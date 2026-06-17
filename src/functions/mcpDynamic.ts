import { createHash } from "node:crypto";
import type { FunctionDeclaration, Schema } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
  listServersGrantedToBot,
  listServersGrantedToBotScoped,
  parseToolsCache,
  type McpServerRecord,
  type McpToolDef,
} from "../db/mcpRepo.js";
import { callTool, refreshToolsCache } from "../services/mcpClient.js";
import { addAuditLog } from "../db/auditRepo.js";

// ─── MCP動的Function（§4.4: MCP ToolをGemini Function Callとして動的登録） ────
// (ownerUserId, botId) スコープで利用可能な enabled なMCPサーバーの tools_cache から
// FunctionDeclaration を動的生成し、gemini.ts のレジストリへマージする。

/** Gemini Function名の制約: 英数字とアンダースコア、64文字未満 */
const MAX_FUNCTION_NAME_LENGTH = 63;
const TOOLS_CACHE_TTL_MS = 60 * 60 * 1000; // 1時間ごとに再取得（§4.4.2）

/** MCPツールのGemini Function名を生成する */
function mcpFunctionName(serverId: number, toolName: string): string {
  const sanitized = toolName.replace(/[^a-zA-Z0-9_]/g, "_");
  const name = `mcp${serverId}_${sanitized}`;
  return name.slice(0, MAX_FUNCTION_NAME_LENGTH);
}

/**
 * 名前衝突時に決定的な短ハッシュを付与して 63 文字以内で一意化する。
 * サニタイズ（`list-items` と `list.items` → `mcp1_list_items`）や 63 文字切り詰めで
 * 別ツールが同名になり、2 番目が無言で捨てられる事故を防ぐ。
 */
function disambiguateFunctionName(serverId: number, toolName: string, used: Set<string>): string {
  const base = mcpFunctionName(serverId, toolName);
  const hash = createHash("sha1").update(`${serverId}:${toolName}`).digest("hex").slice(0, 6);
  let candidate = base.slice(0, MAX_FUNCTION_NAME_LENGTH - (hash.length + 1)) + `_${hash}`;
  let n = 0;
  while (used.has(candidate)) {
    const tag = `_${hash}_${n}`;
    candidate = base.slice(0, MAX_FUNCTION_NAME_LENGTH - tag.length) + tag;
    n++;
  }
  return candidate;
}

/**
 * JSON Schema → Gemini Schema への変換（最小実装）。
 * object/string/number/integer/boolean/array をマップし、未対応型はSTRINGにフォールバック。
 */
function jsonSchemaToGeminiSchema(schema: Record<string, unknown>): Schema {
  // (1) type が配列（例: ["integer","null"] = nullable）の場合は、null 以外の最初の型を採用し
  //     nullable 扱いにする。schemars 1.x は Option<T> をこの形で出力する。
  let rawType: unknown = schema.type;
  let nullable = false;
  if (Array.isArray(rawType)) {
    const types = rawType.map((t) => String(t).toLowerCase());
    nullable = types.includes("null");
    rawType = types.find((t) => t !== "null") ?? "string";
  }

  // (2) type 未指定で anyOf/oneOf/allOf により形が表現される場合（schemars の Option<Struct>/enum 等）、
  //     null 以外の最初のサブスキーマへ委譲する。これをしないと STRING に潰れて
  //     ネストしたプロパティが丸ごと失われる。
  if (rawType === undefined || rawType === null) {
    const combinator =
      (Array.isArray(schema.anyOf) && schema.anyOf) ||
      (Array.isArray(schema.oneOf) && schema.oneOf) ||
      (Array.isArray(schema.allOf) && schema.allOf) ||
      null;
    if (combinator) {
      const subs = (combinator as unknown[]).filter(
        (s): s is Record<string, unknown> => !!s && typeof s === "object"
      );
      const isNullSchema = (s: Record<string, unknown>) => String(s.type).toLowerCase() === "null";
      nullable = nullable || subs.some(isNullSchema);
      const chosen = subs.find((s) => !isNullSchema(s));
      if (chosen) {
        const inner = jsonSchemaToGeminiSchema(
          schema.description && !chosen.description
            ? { ...chosen, description: schema.description }
            : chosen
        );
        return (nullable ? { ...inner, nullable: true } : inner) as Schema;
      }
    }
  }

  const type = String(rawType ?? "string").toLowerCase();
  const description = schema.description ? String(schema.description) : undefined;
  const nullableProp = nullable ? { nullable: true } : {};

  switch (type) {
    case "object": {
      const properties: Record<string, Schema> = {};
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(props)) {
        if (value && typeof value === "object") {
          properties[key] = jsonSchemaToGeminiSchema(value as Record<string, unknown>);
        }
      }
      const required = Array.isArray(schema.required)
        ? (schema.required as unknown[]).map(String).filter((r) => r in properties)
        : undefined;
      return {
        type: SchemaType.OBJECT,
        ...(description ? { description } : {}),
        ...nullableProp,
        properties,
        ...(required && required.length > 0 ? { required } : {}),
      } as Schema;
    }
    case "array": {
      const items =
        schema.items && typeof schema.items === "object"
          ? jsonSchemaToGeminiSchema(schema.items as Record<string, unknown>)
          : { type: SchemaType.STRING };
      return {
        type: SchemaType.ARRAY,
        ...(description ? { description } : {}),
        ...nullableProp,
        items,
      } as Schema;
    }
    case "number":
      return { type: SchemaType.NUMBER, ...(description ? { description } : {}), ...nullableProp } as Schema;
    case "integer":
      return { type: SchemaType.INTEGER, ...(description ? { description } : {}), ...nullableProp } as Schema;
    case "boolean":
      return { type: SchemaType.BOOLEAN, ...(description ? { description } : {}), ...nullableProp } as Schema;
    case "string":
    default: {
      const enumValues = Array.isArray(schema.enum)
        ? (schema.enum as unknown[]).map(String)
        : undefined;
      return {
        type: SchemaType.STRING,
        ...(description ? { description } : {}),
        ...nullableProp,
        ...(enumValues && enumValues.length > 0 ? { enum: enumValues, format: "enum" } : {}),
      } as Schema;
    }
  }
}

/** ツールキャッシュが古いサーバーは再取得する（失敗してもキャッシュで続行） */
async function ensureFreshToolsCache(server: McpServerRecord): Promise<McpToolDef[]> {
  const parsedTs = server.tools_cache_updated
    ? Date.parse(server.tools_cache_updated.replace(" ", "T"))
    : NaN;
  // null・不正日時はキャッシュ未取得とみなして必ず再取得する（NaN を「新鮮」と誤判定して
  // 永久に更新されなくなるのを防ぐ）。
  const cacheAge = Number.isFinite(parsedTs) ? Date.now() - parsedTs : Infinity;

  if (cacheAge > TOOLS_CACHE_TTL_MS) {
    try {
      await refreshToolsCache(server.id);
      // 再取得後のレコードを読むため、キャッシュ文字列を直接更新せず再パースする
      const { getServerById } = await import("../db/mcpRepo.js");
      const fresh = getServerById(server.id);
      if (fresh) return parseToolsCache(fresh);
    } catch (err) {
      console.warn(`[MCP] ${server.name} のToolキャッシュ更新に失敗しました（既存キャッシュで続行）:`, err);
    }
  }
  return parseToolsCache(server);
}

/**
 * MCPサーバー群から FunctionModule を構築する共通処理。
 * @param isStillAvailable 呼び出し時点の利用可能性の再検証（スコープ毎に異なる §4.4.3 / §4.5）
 */
async function buildMcpFunctionModule(
  servers: McpServerRecord[],
  isStillAvailable: (ctx: ToolContext, serverId: number) => boolean
): Promise<FunctionModule> {
  const declarations: FunctionDeclaration[] = [];
  const handlers: FunctionModule["handlers"] = {};

  if (servers.length === 0) {
    return { declarations, handlers };
  }

  const usedNames = new Set<string>();

  for (const server of servers) {
    const tools = await ensureFreshToolsCache(server);

    for (const tool of tools) {
      // 衝突時は捨てずに退避名で一意化する（サニタイズ/63字切り詰めによる別ツールの取りこぼし防止）。
      const baseName = mcpFunctionName(server.id, tool.name);
      let fnName = baseName;
      if (usedNames.has(fnName)) {
        fnName = disambiguateFunctionName(server.id, tool.name, usedNames);
        console.warn(`[MCP] ${server.name}: Function名 "${baseName}" が衝突したため "${fnName}" に退避しました (tool: ${tool.name})`);
      }
      usedNames.add(fnName);

      const confirmNote =
        server.requires_confirmation === 1
          ? "【重要】この外部ツールを実行する前に、必ず実行内容（ツール名・引数）をユーザーへ提示して承認を得てから呼び出すこと。"
          : "";

      const baseDescription = tool.description || tool.name;
      const declaration: FunctionDeclaration = {
        name: fnName,
        description: `[MCP拡張: ${server.name}] ${baseDescription} ${confirmNote}`.trim().slice(0, 1000),
      };

      // パラメータスキーマの変換（propertiesが空のobjectは parameters 自体を省略）
      if (tool.inputSchema && typeof tool.inputSchema === "object") {
        const gemini = jsonSchemaToGeminiSchema(tool.inputSchema);
        const hasProps =
          gemini.type === SchemaType.OBJECT &&
          gemini.properties &&
          Object.keys(gemini.properties).length > 0;
        if (hasProps) {
          declaration.parameters = gemini as FunctionDeclaration["parameters"];
        }
      }

      declarations.push(declaration);

      const toolName = tool.name;
      const serverId = server.id;
      const serverName = server.name;
      handlers[fnName] = async (ctx: ToolContext, args: Record<string, unknown>): Promise<string> => {
        // セキュリティ: 呼び出し時点でも利用可能性を再検証する（§4.4.3）
        const available = isStillAvailable(ctx, serverId);
        if (!available) {
          return JSON.stringify({
            success: false,
            message: "このMCPサーバーは現在利用できません（無効化または削除されています）。",
          });
        }

        const { getServerById } = await import("../db/mcpRepo.js");
        const fresh = getServerById(serverId);
        if (!fresh) {
          return JSON.stringify({ success: false, message: "MCPサーバーが見つかりません。" });
        }

        try {
          // actor=発話ユーザー(§6)。汎用モードでは認証情報の所有者(fresh.user_id, system は null)と
          // 起動元 Bot が actor と異なり得るため、誰の資格情報がどの Bot 経由で使われたかを
          // detail に記録する（秘密値は含めない）。
          addAuditLog(
            ctx.userId,
            "mcp.call",
            `${serverName}:${toolName}`,
            JSON.stringify({ botId: ctx.botId, credentialOwner: fresh.user_id })
          );
          const result = await callTool(fresh, toolName, args);
          return JSON.stringify({
            success: true,
            server: serverName,
            tool: toolName,
            result: result.slice(0, 30000),
          });
        } catch (err) {
          return JSON.stringify({
            success: false,
            message: `MCPツール呼び出しに失敗しました: ${(err as Error).message}`,
          });
        }
      };
    }
  }

  return { declarations, handlers };
}

/**
 * Botインスタンスが利用可能なMCP Toolを FunctionModule として動的生成する。
 * v5: 利用許可(bot_mcp_access)で当該Botに付与されたサーバー + システムレベルサーバー。
 *
 * v7（クロステナント露出の修正）: 発話者(speakerUserId)を考慮する。
 * - 共有秘書(system_default)は全ユーザーが会話するため、「発話者本人が付与した許可」分のみ
 *   ＋システムレベル(user_id IS NULL)に限定する。他人が付与した許可（他人の認証情報を抱えた
 *   MCPサーバー）が発話者の会話へ漏れないようにする。
 * - 所有Bot（単一owner）は owner が設定した許可をそのまま使う（現挙動を維持）。
 * 呼び出し時の再検証クロージャも同じスコープ（system_default のみ ctx.userId で絞る）で行う。
 */
export async function getMcpFunctionModuleForBot(
  botId: string,
  speakerUserId: string
): Promise<FunctionModule> {
  const isSharedSecretary = botId === "system_default";

  let servers: McpServerRecord[];
  try {
    servers = (
      isSharedSecretary
        ? listServersGrantedToBotScoped(botId, speakerUserId)
        : listServersGrantedToBot(botId)
    ).filter((s) => s.enabled === 1);
  } catch (err) {
    console.error(`[MCP] Bot ${botId} のサーバー一覧の取得に失敗しました:`, err);
    return { declarations: [], handlers: {} };
  }

  return buildMcpFunctionModule(servers, (ctx, serverId) => {
    const visible = isSharedSecretary
      ? listServersGrantedToBotScoped(ctx.botId, ctx.userId)
      : listServersGrantedToBot(ctx.botId);
    return visible.some((s) => s.id === serverId && s.enabled === 1);
  });
}
