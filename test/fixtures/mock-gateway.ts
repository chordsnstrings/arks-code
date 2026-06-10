import type { ApiToolCall, StreamRequest, StreamResult } from '../../src/gateway/client.js';

export interface ScriptStep {
  content?: string;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
}

/**
 * Mock gateway for integration tests (SDD §10): plays back a canned script of
 * responses, recording every request it receives. No network.
 */
export class MockGateway {
  requests: StreamRequest[] = [];
  private step = 0;

  constructor(private script: ScriptStep[]) {}

  stream = async (req: StreamRequest): Promise<StreamResult> => {
    this.requests.push(structuredClone({ ...req, onTextDelta: undefined, signal: undefined }));
    const s = this.script[Math.min(this.step, this.script.length - 1)];
    this.step++;
    if (!s) throw new Error('MockGateway: script exhausted');
    const content = s.content ?? '';
    if (content) req.onTextDelta?.(content);
    const toolCalls: ApiToolCall[] = (s.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${this.step}_${i}`,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
    return {
      content,
      toolCalls,
      usage: { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 10 },
      durationMs: 5,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  };
}
