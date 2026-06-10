import type { ToolDefinition } from '../gateway/client.js';
import { editFileTool, globTool, readFileTool, writeFileTool } from './fs.js';
import { grepTool } from './search.js';
import { bashTool } from './shell.js';
import { todoTool } from './todo.js';
import type { RegisteredTool, ToolContext } from './types.js';

export const ALL_TOOLS: RegisteredTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  bashTool,
  grepTool,
  globTool,
  todoTool,
];

const byName = new Map(ALL_TOOLS.map((t) => [t.definition.function.name, t]));

export function toolDefinitions(): ToolDefinition[] {
  return ALL_TOOLS.map((t) => t.definition);
}

export function getTool(name: string): RegisteredTool | undefined {
  return byName.get(name);
}

export interface ParsedCall {
  tool: RegisteredTool;
  args: Record<string, unknown>;
}

/** Parse a tool call's name + JSON arguments; returns an error string on failure. */
export function parseCall(name: string, argumentsJson: string): ParsedCall | string {
  const tool = byName.get(name);
  if (!tool) return `Error: unknown tool "${name}". Available: ${[...byName.keys()].join(', ')}.`;
  let args: Record<string, unknown> = {};
  if (argumentsJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(argumentsJson);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return `Error: tool arguments must be a JSON object, got: ${argumentsJson.slice(0, 200)}`;
      }
      args = parsed as Record<string, unknown>;
    } catch (err) {
      return `Error: could not parse tool arguments as JSON (${(err as Error).message}): ${argumentsJson.slice(0, 200)}`;
    }
  }
  return { tool, args };
}

/**
 * Execute a tool call. NEVER throws — every failure path returns text for the
 * model (CLAUDE.md rule 6).
 */
export async function executeCall(
  name: string,
  argumentsJson: string,
  ctx: ToolContext,
): Promise<string> {
  const parsed = parseCall(name, argumentsJson);
  if (typeof parsed === 'string') return parsed;
  try {
    return await parsed.tool.execute(parsed.args, ctx);
  } catch (err) {
    return `Error: ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
