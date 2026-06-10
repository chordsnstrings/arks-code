import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ServerScriptStep {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

/**
 * A real local HTTP server speaking OpenAI-compatible SSE, for end-to-end
 * tests of the built CLI. Plays one scripted response per request, with
 * tool-call arguments deliberately fragmented across SSE chunks.
 */
export function startSseServer(script: ServerScriptStep[]): Promise<{ url: string; close: () => Promise<void> }> {
  let step = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'code-fast' }, { id: 'code-deep' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s = script[Math.min(step++, script.length - 1)] ?? {};
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (s.content) {
        // stream the text in two pieces
        const mid = Math.ceil(s.content.length / 2);
        send({ choices: [{ delta: { role: 'assistant', content: s.content.slice(0, mid) } }] });
        send({ choices: [{ delta: { content: s.content.slice(mid) } }] });
      }
      (s.toolCalls ?? []).forEach((c, index) => {
        const argsJson = JSON.stringify(c.args);
        const mid = Math.ceil(argsJson.length / 2);
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index, id: c.id, type: 'function', function: { name: c.name, arguments: argsJson.slice(0, mid) } },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: argsJson.slice(mid) } }] } }] });
      });
      send({
        choices: [{ delta: {}, finish_reason: (s.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop' }],
      });
      send({
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 5 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
