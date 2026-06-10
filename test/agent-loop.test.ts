import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '../src/agent/context.js';
import { MAX_ITERATIONS, runTurn, type LoopDeps } from '../src/agent/loop.js';
import type { ChatMessage } from '../src/gateway/client.js';
import type { ToolContext } from '../src/tools/types.js';
import { MockGateway, type ScriptStep } from './fixtures/mock-gateway.js';
import { makeCtx, makeTmpDir, write } from './helpers.js';

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = makeTmpDir();
  ctx = makeCtx(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeDeps(script: ScriptStep[], overrides: Partial<LoopDeps> = {}) {
  const gw = new MockGateway(script);
  const deps: LoopDeps = {
    stream: gw.stream,
    model: () => 'code-fast',
    ctx,
    gate: async () => ({ allowed: true }),
    compactThreshold: 1_000_000,
    estimateTokens,
    compact: async () => ({}),
    ...overrides,
  };
  return { gw, deps };
}

function baseMessages(): ChatMessage[] {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do the thing' },
  ];
}

describe('agent loop', () => {
  it('text-only response ends the turn', async () => {
    const { deps } = makeDeps([{ content: 'All done.' }]);
    const messages = baseMessages();
    const res = await runTurn(deps, messages);
    expect(res).toEqual({ stopped: 'done', content: 'All done.' });
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'All done.' });
  });

  it('executes tool calls and appends assistant-then-tool messages (OpenAI ordering)', async () => {
    write(dir, 'hello.txt', 'salut');
    const { gw, deps } = makeDeps([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'hello.txt' } }] },
      { content: 'File read.' },
    ]);
    const messages = baseMessages();
    await runTurn(deps, messages);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    const assistant = messages[2] as ChatMessage & { tool_calls?: unknown[] };
    expect(assistant.tool_calls).toHaveLength(1);
    const toolMsg = messages[3] as { role: string; tool_call_id: string; content: string };
    expect(toolMsg.tool_call_id).toBe('c1');
    expect(toolMsg.content).toContain('salut');
    // the second model request saw the tool result
    expect(gw.requests[1]!.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('tool failures become text for the model and never crash the loop (CLAUDE.md rule 6)', async () => {
    const { deps } = makeDeps([
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'does-not-exist.txt' } }] },
      { content: 'Recovered.' },
    ]);
    const messages = baseMessages();
    const res = await runTurn(deps, messages);
    expect(res.stopped).toBe('done');
    const toolMsg = messages[3] as { content: string };
    expect(toolMsg.content).toMatch(/^Error: file not found/);
  });

  it('a malformed-arguments tool call also returns text instead of crashing', async () => {
    const gw = new MockGateway([{}, { content: 'ok' }]);
    // hand-craft a call with broken JSON arguments
    gw.stream = async (req) => {
      if ((req.messages.at(-1) as { role: string }).role === 'user') {
        return {
          content: '',
          toolCalls: [{ id: 'x', type: 'function', function: { name: 'bash', arguments: '{"command": ' } }],
          usage: null,
          durationMs: 1,
          finishReason: 'tool_calls',
        };
      }
      return { content: 'ok', toolCalls: [], usage: null, durationMs: 1, finishReason: 'stop' };
    };
    const deps: LoopDeps = {
      stream: gw.stream,
      model: () => 'code-fast',
      ctx,
      gate: async () => ({ allowed: true }),
      compactThreshold: 1_000_000,
      estimateTokens,
      compact: async () => ({}),
    };
    const messages = baseMessages();
    const res = await runTurn(deps, messages);
    expect(res.stopped).toBe('done');
    const toolMsg = messages[3] as { content: string };
    expect(toolMsg.content).toMatch(/^Error: could not parse tool arguments/);
  });

  it('denied calls report "User denied this action." without executing', async () => {
    const { deps } = makeDeps(
      [
        { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'x.txt', content: 'nope' } }] },
        { content: 'understood' },
      ],
      { gate: async () => ({ allowed: false, reason: 'Denied by user.' }) },
    );
    const messages = baseMessages();
    await runTurn(deps, messages);
    const toolMsg = messages[3] as { content: string };
    expect(toolMsg.content).toBe('User denied this action. Denied by user.');
    expect(fs.existsSync(path.join(dir, 'x.txt'))).toBe(false);
  });

  it('stops after MAX_ITERATIONS and reports', async () => {
    // a script that always asks for another tool call
    const { deps } = makeDeps([{ toolCalls: [{ name: 'glob', args: { pattern: '*' } }] }]);
    const messages = baseMessages();
    const res = await runTurn(deps, messages);
    expect(res.stopped).toBe('max-iterations');
    const assistantCalls = messages.filter((m) => m.role === 'assistant').length;
    expect(assistantCalls).toBe(MAX_ITERATIONS);
  });

  it('truncates oversized tool results to ~30k chars', async () => {
    write(dir, 'big.txt', 'x'.repeat(60_000));
    const { deps } = makeDeps([
      { toolCalls: [{ name: 'read_file', args: { path: 'big.txt' } }] },
      { content: 'done' },
    ]);
    const messages = baseMessages();
    await runTurn(deps, messages);
    const toolMsg = messages[3] as { content: string };
    expect(toolMsg.content.length).toBeLessThanOrEqual(30_100);
  });

  it('invokes compaction when the estimate exceeds the threshold', async () => {
    const compact = vi.fn(async (msgs: ChatMessage[]) => {
      msgs.splice(1, msgs.length - 2, { role: 'assistant', content: '[summary]' });
    });
    const { deps } = makeDeps(
      [
        { toolCalls: [{ name: 'glob', args: { pattern: '*' } }] },
        { content: 'finished' },
      ],
      { compactThreshold: 10, compact },
    );
    await runTurn(deps, baseMessages());
    expect(compact).toHaveBeenCalled();
  });

  it('reports usage per model call', async () => {
    const usages: unknown[] = [];
    const { deps } = makeDeps(
      [{ toolCalls: [{ name: 'glob', args: { pattern: '*' } }] }, { content: 'fin' }],
      { onUsage: (_m, u) => usages.push(u) },
    );
    await runTurn(deps, baseMessages());
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ prompt_tokens: 100 });
  });

  it('keeps the loop under 80 lines excluding types (CLAUDE.md rule 5)', () => {
    const src = fs.readFileSync(new URL('../src/agent/loop.ts', import.meta.url), 'utf8');
    // strip interface/type blocks, comments, imports and blank lines
    const body = src
      .replace(/^export interface [\s\S]*?^\}/gm, '')
      .replace(/^import [\s\S]*?;$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(body.length).toBeLessThanOrEqual(80);
  });
});
