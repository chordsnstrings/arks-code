/**
 * OpenAI-compatible chat-completions client for the ARKS AI Gateway (SDD §7).
 * SSE streaming, tool-call delta assembly, retry (2x on network/5xx with
 * 1s/4s backoff), usage capture for the ledger. No provider abstraction —
 * the gateway IS the abstraction.
 */

export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** Cache-hit prompt tokens. The gateway passes DeepSeek's fields through. */
  cached_tokens: number;
}

export interface StreamResult {
  content: string;
  toolCalls: ApiToolCall[];
  usage: Usage | null;
  durationMs: number;
  finishReason: string | null;
}

export interface StreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayClientOptions {
  baseURL: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Time allowed for response headers to arrive (default 10s). */
  connectTimeoutMs?: number;
  /** Total per-call timeout (default 600s — code-deep thinks long). */
  totalTimeoutMs?: number;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SseToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface SseChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: SseToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  } | null;
}

/**
 * Assembles fragmented tool-call deltas across SSE chunks. Arguments arrive
 * as partial JSON strings that must be concatenated before parsing
 * (CLAUDE.md landmine #1).
 */
export class ToolCallAssembler {
  private calls = new Map<number, { id: string; name: string; args: string }>();

  add(deltas: SseToolCallDelta[]): void {
    for (const d of deltas) {
      let entry = this.calls.get(d.index);
      if (!entry) {
        entry = { id: '', name: '', args: '' };
        this.calls.set(d.index, entry);
      }
      if (d.id) entry.id = d.id;
      if (d.function?.name) entry.name += d.function.name;
      if (d.function?.arguments) entry.args += d.function.arguments;
    }
  }

  finish(): ApiToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args },
      }));
  }
}

/** Incremental SSE parser: feed raw text, get back `data:` payloads. */
export class SseParser {
  private buffer = '';

  feed(text: string): string[] {
    this.buffer += text;
    const events: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        events.push(line.slice(5).trimStart());
      }
    }
    return events;
  }
}

function normalizeUsage(u: NonNullable<SseChunk['usage']>): Usage {
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
  };
}

export class GatewayClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: GatewayClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.totalTimeoutMs = opts.totalTimeoutMs ?? 600_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  /** Stream a chat completion; retries on network errors and 5xx only. */
  async stream(req: StreamRequest): Promise<StreamResult> {
    const backoffs = [1_000, 4_000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.streamOnce(req);
      } catch (err) {
        if (req.signal?.aborted) throw err;
        const retryable =
          !(err instanceof GatewayError) || (err.status !== undefined && err.status >= 500);
        if (!retryable || attempt === this.maxRetries) throw err;
        lastError = err;
        await this.sleep(backoffs[attempt] ?? 4_000);
      }
    }
    throw lastError as Error;
  }

  /** GET {baseURL}/models — used by /model to validate aliases. */
  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseURL}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: AbortSignal.timeout(this.connectTimeoutMs),
    });
    if (!res.ok) {
      throw new GatewayError(`GET /models failed: HTTP ${res.status}`, res.status);
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
  }

  private async streamOnce(req: StreamRequest): Promise<StreamResult> {
    const start = Date.now();
    const controller = new AbortController();
    const onUserAbort = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener('abort', onUserAbort, { once: true });
    const totalTimer = setTimeout(
      () => controller.abort(new GatewayError(`Call exceeded ${this.totalTimeoutMs / 1000}s`)),
      this.totalTimeoutMs,
    );
    let connectTimer: NodeJS.Timeout | undefined = setTimeout(
      () => controller.abort(new GatewayError(`Connect timeout after ${this.connectTimeoutMs / 1000}s`)),
      this.connectTimeoutMs,
    );

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        // Surface our own timeout/abort reason instead of the generic AbortError.
        if (controller.signal.aborted && controller.signal.reason instanceof GatewayError) {
          throw controller.signal.reason;
        }
        throw err;
      } finally {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new GatewayError(`Gateway HTTP ${res.status}: ${body}`, res.status, body);
      }
      if (!res.body) throw new GatewayError('Gateway returned an empty response body');

      const parser = new SseParser();
      const assembler = new ToolCallAssembler();
      const decoder = new TextDecoder();
      let content = '';
      let usage: Usage | null = null;
      let finishReason: string | null = null;

      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        for (const data of parser.feed(decoder.decode(chunk, { stream: true }))) {
          if (data === '[DONE]') continue;
          let parsed: SseChunk;
          try {
            parsed = JSON.parse(data) as SseChunk;
          } catch {
            continue; // tolerate malformed keep-alive/comment payloads
          }
          if (parsed.usage) usage = normalizeUsage(parsed.usage);
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;
          if (choice.delta?.content) {
            content += choice.delta.content;
            req.onTextDelta?.(choice.delta.content);
          }
          if (choice.delta?.tool_calls) assembler.add(choice.delta.tool_calls);
        }
      }

      return {
        content,
        toolCalls: assembler.finish(),
        usage,
        durationMs: Date.now() - start,
        finishReason,
      };
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason instanceof GatewayError) {
        throw controller.signal.reason;
      }
      throw err;
    } finally {
      clearTimeout(totalTimer);
      if (connectTimer) clearTimeout(connectTimer);
      req.signal?.removeEventListener('abort', onUserAbort);
    }
  }
}
