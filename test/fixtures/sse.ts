/**
 * Recorded-style SSE chunk fixtures. Tool-call arguments arrive as partial
 * JSON string fragments split across chunks — sometimes mid-token, sometimes
 * with several SSE events per network chunk, sometimes one event split across
 * two network chunks.
 */

function ev(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** A plain text completion split across chunks, with usage in the tail. */
export const textStreamChunks: string[] = [
  ev({ choices: [{ delta: { role: 'assistant', content: '' } }] }),
  ev({ choices: [{ delta: { content: 'Hello' } }] }),
  ev({ choices: [{ delta: { content: ', world' } }] }),
  ev({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ev({
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 4 },
  }),
  'data: [DONE]\n\n',
];

/**
 * Two tool calls; the arguments of the first are fragmented across 4 chunks
 * (split mid-JSON-string), the second arrives interleaved by index.
 */
export const fragmentedToolCallChunks: string[] = [
  ev({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } },
          ],
        },
      },
    ],
  }),
  ev({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }],
  }),
  ev({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "src/au' } }] } }],
  }),
  ev({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 1, id: 'call_def', type: 'function', function: { name: 'bash', arguments: '{"comm' } },
          ],
        },
      },
    ],
  }),
  ev({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th.ts"}' } }] } }],
  }),
  ev({
    choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'and": "npm test"}' } }] } }],
  }),
  ev({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
  ev({
    choices: [],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      prompt_tokens_details: { cached_tokens: 64 },
    },
  }),
  'data: [DONE]\n\n',
];

/** One SSE event split across two network chunks mid-line. */
export const splitEventChunks: string[] = (() => {
  const whole = ev({ choices: [{ delta: { content: 'split across the wire' } }] });
  const mid = Math.floor(whole.length / 2);
  return [whole.slice(0, mid), whole.slice(mid), 'data: [DONE]\n\n'];
})();

export function chunksToStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

export function sseResponse(chunks: string[]): Response {
  return new Response(chunksToStream(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}
