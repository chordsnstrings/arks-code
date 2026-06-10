import { describe, expect, it } from 'vitest';
import { GatewayClient, GatewayError, SseParser, ToolCallAssembler } from '../src/gateway/client.js';
import {
  fragmentedToolCallChunks,
  splitEventChunks,
  sseResponse,
  textStreamChunks,
} from './fixtures/sse.js';

const noSleep = async () => {};

function client(fetchImpl: typeof fetch, opts: Partial<ConstructorParameters<typeof GatewayClient>[0]> = {}) {
  return new GatewayClient({
    baseURL: 'https://gw.example.com/v1',
    apiKey: 'test-key',
    fetchImpl,
    sleep: noSleep,
    ...opts,
  });
}

describe('SseParser', () => {
  it('extracts data payloads and handles partial lines across feeds', () => {
    const p = new SseParser();
    expect(p.feed('data: {"a"')).toEqual([]);
    expect(p.feed(':1}\n\ndata: [DONE]\n\n')).toEqual(['{"a":1}', '[DONE]']);
  });

  it('handles CRLF line endings', () => {
    const p = new SseParser();
    expect(p.feed('data: x\r\n\r\n')).toEqual(['x']);
  });
});

describe('ToolCallAssembler', () => {
  it('concatenates fragmented arguments per index and orders by index', () => {
    const a = new ToolCallAssembler();
    a.add([{ index: 1, id: 'b', function: { name: 'beta', arguments: '{"y"' } }]);
    a.add([{ index: 0, id: 'a', function: { name: 'alpha', arguments: '{"x"' } }]);
    a.add([{ index: 1, function: { arguments: ':2}' } }]);
    a.add([{ index: 0, function: { arguments: ':1}' } }]);
    const calls = a.finish();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ id: 'a', function: { name: 'alpha', arguments: '{"x":1}' } });
    expect(calls[1]).toMatchObject({ id: 'b', function: { name: 'beta', arguments: '{"y":2}' } });
  });
});

describe('GatewayClient.stream', () => {
  it('streams text deltas and captures usage (DeepSeek cache-hit field)', async () => {
    const deltas: string[] = [];
    const gw = client(async () => sseResponse(textStreamChunks));
    const res = await gw.stream({
      model: 'code-fast',
      messages: [{ role: 'user', content: 'hi' }],
      onTextDelta: (t) => deltas.push(t),
    });
    expect(res.content).toBe('Hello, world');
    expect(deltas.join('')).toBe('Hello, world');
    expect(res.toolCalls).toEqual([]);
    expect(res.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, cached_tokens: 4 });
    expect(res.finishReason).toBe('stop');
  });

  it('assembles tool calls whose JSON arguments are fragmented across chunks', async () => {
    const gw = client(async () => sseResponse(fragmentedToolCallChunks));
    const res = await gw.stream({ model: 'code-fast', messages: [{ role: 'user', content: 'go' }] });
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0]?.id).toBe('call_abc');
    expect(JSON.parse(res.toolCalls[0]!.function.arguments)).toEqual({ path: 'src/auth.ts' });
    expect(res.toolCalls[1]?.id).toBe('call_def');
    expect(JSON.parse(res.toolCalls[1]!.function.arguments)).toEqual({ command: 'npm test' });
    expect(res.usage).toEqual({ prompt_tokens: 100, completion_tokens: 30, cached_tokens: 64 });
  });

  it('reassembles an SSE event split across network chunks', async () => {
    const gw = client(async () => sseResponse(splitEventChunks));
    const res = await gw.stream({ model: 'code-fast', messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('split across the wire');
  });

  it('retries twice on 5xx then succeeds', async () => {
    let calls = 0;
    const gw = client(async () => {
      calls++;
      if (calls < 3) return new Response('upstream sad', { status: 502 });
      return sseResponse(textStreamChunks);
    });
    const res = await gw.stream({ model: 'code-fast', messages: [{ role: 'user', content: 'x' }] });
    expect(calls).toBe(3);
    expect(res.content).toBe('Hello, world');
  });

  it('gives up after 2 retries on persistent 5xx', async () => {
    let calls = 0;
    const gw = client(async () => {
      calls++;
      return new Response('boom', { status: 500 });
    });
    await expect(
      gw.stream({ model: 'code-fast', messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(GatewayError);
    expect(calls).toBe(3);
  });

  it('does NOT retry 4xx and surfaces the body verbatim', async () => {
    let calls = 0;
    const gw = client(async () => {
      calls++;
      return new Response('{"error":"invalid model alias"}', { status: 400 });
    });
    const err = await gw
      .stream({ model: 'nope', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(400);
    expect((err as GatewayError).body).toContain('invalid model alias');
    expect(calls).toBe(1);
  });

  it('retries on network errors', async () => {
    let calls = 0;
    const gw = client(async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return sseResponse(textStreamChunks);
    });
    const res = await gw.stream({ model: 'code-fast', messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('Hello, world');
    expect(calls).toBe(2);
  });

  it('does not retry when aborted by the caller', async () => {
    let calls = 0;
    const ac = new AbortController();
    const gw = client(async () => {
      calls++;
      ac.abort(new Error('user cancelled'));
      throw new Error('user cancelled');
    });
    await expect(
      gw.stream({ model: 'code-fast', messages: [{ role: 'user', content: 'x' }], signal: ac.signal }),
    ).rejects.toThrow('user cancelled');
    expect(calls).toBe(1);
  });

  it('sends auth header, tools and stream options', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const gw = client(async (url, init) => {
      captured = { url: String(url), init: init! };
      return sseResponse(textStreamChunks);
    });
    await gw.stream({
      model: 'code-fast',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }],
    });
    expect(captured!.url).toBe('https://gw.example.com/v1/chat/completions');
    expect((captured!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toHaveLength(1);
  });
});

describe('GatewayClient.listModels', () => {
  it('returns model ids', async () => {
    const gw = client(async () =>
      new Response(JSON.stringify({ data: [{ id: 'code-fast' }, { id: 'code-deep' }] }), { status: 200 }),
    );
    expect(await gw.listModels()).toEqual(['code-fast', 'code-deep']);
  });
});
