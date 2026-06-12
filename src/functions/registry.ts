import type { FunctionDeclaration } from "@google/generative-ai";
import type { FunctionModule, ToolContext } from "../types/contracts.js";

/**
 * FunctionModule 群をマージして単一のレジストリを構築する。
 * functions/index.ts（統合層）が全モジュールを集約する際に使用する。
 */
export function buildFunctionRegistry(modules: FunctionModule[]): {
  declarations: FunctionDeclaration[];
  dispatch: (ctx: ToolContext, name: string, args: Record<string, unknown>) => Promise<string>;
  has: (name: string) => boolean;
} {
  const declarations: FunctionDeclaration[] = [];
  const handlers = new Map<
    string,
    (ctx: ToolContext, args: Record<string, unknown>) => Promise<string> | string
  >();

  for (const mod of modules) {
    for (const decl of mod.declarations) {
      if (handlers.has(decl.name) || declarations.some((d) => d.name === decl.name)) {
        throw new Error(`Function名が重複しています: ${decl.name}`);
      }
      declarations.push(decl);
    }
    for (const [name, handler] of Object.entries(mod.handlers)) {
      if (handlers.has(name)) {
        throw new Error(`Functionハンドラが重複しています: ${name}`);
      }
      handlers.set(name, handler);
    }
  }

  return {
    declarations,
    has: (name: string) => handlers.has(name),
    async dispatch(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
      const handler = handlers.get(name);
      if (!handler) {
        return JSON.stringify({ success: false, message: `不明な関数: ${name}` });
      }
      try {
        return await handler(ctx, args);
      } catch (err) {
        console.error(`🔧 Function "${name}" の実行中にエラーが発生しました:`, err);
        return JSON.stringify({ success: false, message: (err as Error).message });
      }
    },
  };
}
