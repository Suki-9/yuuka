import type { FunctionDeclaration, Schema } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";
import {
  listServersForUser,
  listServersForBot,
  parseToolsCache,
  type McpServerRecord,
  type McpToolDef,
} from "../db/mcpRepo.js";
import { callTool, refreshToolsCache } from "../services/mcpClient.js";
import { addAuditLog } from "../db/auditRepo.js";

// ─── MCP動的Function（§4.4: MCP ToolをGemini Function Callとして動的登録） ────
// ユーザーが利用可能な enabled なMCPサーバーの tools_cache から
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
 * JSON Schema → Gemini Schema への変換（最小実装）。
 * object/string/number/integer/boolean/array をマップし、未対応型はSTRINGにフォールバック。
 */
function jsonSchemaToGeminiSchema(schema: Record<string, unknown>): Schema {
  const type = String(schema.type ?? "string").toLowerCase();
  const description = schema.description ? String(schema.description) : undefined;

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
        properties,
        ...(required && required.length > 0 ? { required } : {}),
      };
    }
    case "array": {
      const items =
        schema.items && typeof schema.items === "object"
          ? jsonSchemaToGeminiSchema(schema.items as Record<string, unknown>)
          : { type: SchemaType.STRING };
      return {
        type: SchemaType.ARRAY,
        ...(description ? { description } : {}),
        items,
      } as Schema;
    }
    case "number":
      return { type: SchemaType.NUMBER, ...(description ? { description } : {}) } as Schema;
    case "integer":
      return { type: SchemaType.INTEGER, ...(description ? { description } : {}) } as Schema;
    case "boolean":
      return { type: SchemaType.BOOLEAN, ...(description ? { description } : {}) } as Schema;
    case "string":
    default: {
      const enumValues = Array.isArray(schema.enum)
        ? (schema.enum as unknown[]).map(String)
        : undefined;
      return {
        type: SchemaType.STRING,
        ...(description ? { description } : {}),
        ...(enumValues && enumValues.length > 0 ? { enum: enumValues, format: "enum" } : {}),
      } as Schema;
    }
  }
}

/** ツールキャッシュが古いサーバーは再取得する（失敗してもキャッシュで続行） */
async function ensureFreshToolsCache(server: McpServerRecord): Promise<McpToolDef[]> {
  const cacheAge = server.tools_cache_updated
    ? Date.now() - new Date(server.tools_cache_updated.replace(" ", "T")).getTime()
    : Infinity;

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
      const fnName = mcpFunctionName(server.id, tool.name);
      if (usedNames.has(fnName)) continue; // 同名衝突はスキップ（先勝ち）
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
          addAuditLog(ctx.userId, "mcp.call", `${serverName}:${toolName}`);
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
 * ユーザーが利用可能なMCP Toolを FunctionModule として動的生成する。
 * gemini.ts が processMessage 毎に呼び出し、静的モジュールとマージする。
 */
export async function getMcpFunctionModuleForUser(userId: string): Promise<FunctionModule> {
  let servers: McpServerRecord[];
  try {
    servers = listServersForUser(userId).filter((s) => s.enabled === 1);
  } catch (err) {
    console.error("[MCP] サーバー一覧の取得に失敗しました:", err);
    return { declarations: [], handlers: {} };
  }

  return buildMcpFunctionModule(servers, (ctx, serverId) =>
    listServersForUser(ctx.userId).some((s) => s.id === serverId && s.enabled === 1)
  );
}

/**
 * Botインスタンスが利用可能なMCP Toolを FunctionModule として動的生成する
 * （bot_attributes_requirements.md §4.5: bot_mcp_links で紐付けたサーバー + システムレベルのみ。
 *   発話ユーザー個人のMCPサーバーは参照しない）。
 * 監査ログは既存方針どおり発話ユーザーを actor として記録される（要件 §6）。
 */
export async function getMcpFunctionModuleForBot(botId: string): Promise<FunctionModule> {
  let servers: McpServerRecord[];
  try {
    servers = listServersForBot(botId).filter((s) => s.enabled === 1);
  } catch (err) {
    console.error(`[MCP] Bot ${botId} のサーバー一覧の取得に失敗しました:`, err);
    return { declarations: [], handlers: {} };
  }

  return buildMcpFunctionModule(servers, (ctx, serverId) =>
    listServersForBot(ctx.botId).some((s) => s.id === serverId && s.enabled === 1)
  );
}
