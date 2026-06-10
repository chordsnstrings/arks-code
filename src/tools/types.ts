import type { ToolDefinition } from '../gateway/client.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

/** Mutable per-session state shared by all tools. */
export interface ToolContext {
  /** Current working directory; `cd` in the bash tool persists here. */
  cwd: string;
  /** Git repo root (or launch cwd when not in a repo). Paths outside it are gated. */
  repoRoot: string;
  todos: TodoItem[];
  onTodosChanged?: (items: TodoItem[]) => void;
}

export type GateClass = 'fileWrite' | 'shell' | null;

export interface RegisteredTool {
  definition: ToolDefinition;
  /** Which permission class gates this tool; null = never gated. */
  gate: GateClass;
  /** One-line summary for the REPL tool-activity line. */
  summarize(args: Record<string, unknown>, ctx: ToolContext): string;
  /**
   * Preview shown in the approval prompt: a diff for edits/writes, the exact
   * command for bash. Null for ungated tools.
   */
  preview?(args: Record<string, unknown>, ctx: ToolContext): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
