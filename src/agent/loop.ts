import type { ApiToolCall, ChatMessage, StreamRequest, StreamResult, Usage } from '../gateway/client.js';
import { executeCall, getTool, toolDefinitions } from '../tools/registry.js';
import { truncateOutput } from '../tools/shell.js';
import type { RegisteredTool, ToolContext } from '../tools/types.js';

export const MAX_ITERATIONS = 50;
const MAX_RESULT_CHARS = 30_000;

export interface GateRequest {
  call: ApiToolCall;
  tool: RegisteredTool | undefined;
  args: Record<string, unknown>;
}

export interface GateDecision {
  allowed: boolean;
  /** Extra text appended to the denial message the model sees. */
  reason?: string;
}

export interface LoopDeps {
  stream(req: StreamRequest): Promise<StreamResult>;
  model: () => string;
  ctx: ToolContext;
  /** Permission gate (policy/permissions.ts); may prompt the user. */
  gate(req: GateRequest): Promise<GateDecision>;
  compactThreshold: number;
  estimateTokens(messages: ChatMessage[]): number;
  compact(messages: ChatMessage[]): Promise<unknown>;
  onTextDelta?(text: string): void;
  onToolStart?(call: ApiToolCall, args: Record<string, unknown>): void;
  onToolEnd?(call: ApiToolCall, result: string, ms: number): void;
  onUsage?(model: string, usage: Usage | null, durationMs: number): void;
  signal?: AbortSignal;
}

export interface TurnResult {
  stopped: 'done' | 'max-iterations';
  content: string;
}

function parseArgs(call: ApiToolCall): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(call.function.arguments || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * THE core loop (SDD §2): call model → if tool_calls: gate → execute →
 * append results → continue; else render final text → break.
 *
 * Deviation from SDD §2 pseudocode, required by the OpenAI protocol: the
 * assistant message carrying tool_calls is appended BEFORE its tool results
 * (the gateway rejects tool messages that do not follow their assistant turn).
 *
 * Complexity lives in tools/ and policy/ — never here (CLAUDE.md rule 5).
 */
export async function runTurn(deps: LoopDeps, messages: ChatMessage[]): Promise<TurnResult> {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await deps.stream({
      model: deps.model(),
      messages,
      tools: toolDefinitions(),
      signal: deps.signal,
      onTextDelta: deps.onTextDelta,
    });
    deps.onUsage?.(deps.model(), resp.usage, resp.durationMs);

    if (resp.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: resp.content });
      return { stopped: 'done', content: resp.content };
    }
    messages.push({ role: 'assistant', content: resp.content || null, tool_calls: resp.toolCalls });

    for (const call of resp.toolCalls) {
      const args = parseArgs(call);
      const decision = await deps.gate({ call, tool: getTool(call.function.name), args });
      let result: string;
      if (!decision.allowed) {
        result = `User denied this action.${decision.reason ? ` ${decision.reason}` : ''}`;
      } else {
        deps.onToolStart?.(call, args);
        const start = Date.now();
        result = await executeCall(call.function.name, call.function.arguments, deps.ctx);
        deps.onToolEnd?.(call, result, Date.now() - start);
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncateOutput(result, MAX_RESULT_CHARS) });
    }

    if (deps.estimateTokens(messages) > deps.compactThreshold) {
      await deps.compact(messages);
    }
  }
  return { stopped: 'max-iterations', content: '' };
}
