import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import type { StreamRequest, StreamResult } from '../src/gateway/client.js';
import { Ledger } from '../src/ledger/ledger.js';
import { makePalette } from '../src/repl/colors.js';
import { Session } from '../src/repl/session.js';
import { makeTmpDir, write } from './helpers.js';

/**
 * GOALS criterion 6 end-to-end: a low compactThreshold forces real compaction
 * mid-turn (using the real compactMessages, not a spy) and the turn finishes
 * without user-visible failure.
 */

let dir: string;
let output: string;
const plain = makePalette({ noColor: true });

beforeEach(() => {
  dir = fs.realpathSync(makeTmpDir());
  output = '';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeSession(stream: (req: StreamRequest) => Promise<StreamResult>, threshold: number) {
  return new Session({
    cwd: dir,
    config: { ...DEFAULT_CONFIG, baseURL: 'https://gw/v1', compactThreshold: threshold },
    yolo: true,
    stream,
    ledger: new Ledger({
      dir: path.join(dir, '.ledger'),
      sessionId: 's',
      repo: 'r',
      branch: null,
      pricing: DEFAULT_CONFIG.pricing,
    }),
    promptUser: async () => 'yes',
    out: (s) => (output += s),
    palette: plain,
  });
}

describe('compaction end-to-end', () => {
  it('compacts mid-turn with the real summarizer and the turn completes', async () => {
    write(dir, 'noise.txt', 'lorem ipsum '.repeat(500)); // ~6k chars per read
    let calls = 0;
    const stream = async (req: StreamRequest): Promise<StreamResult> => {
      calls++;
      const last = req.messages.at(-1)!;
      // the compaction request ends with the summarize instruction
      if (last.role === 'user' && (last as { content: string }).content.includes('Summarize the conversation')) {
        return { content: 'SUMMARY-NOTE', toolCalls: [], usage: null, durationMs: 1, finishReason: 'stop' };
      }
      if (calls >= 8) {
        req.onTextDelta?.('all done');
        return { content: 'all done', toolCalls: [], usage: null, durationMs: 1, finishReason: 'stop' };
      }
      return {
        content: '',
        toolCalls: [
          { id: `c${calls}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"noise.txt"}' } },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1, cached_tokens: 0 },
        durationMs: 1,
        finishReason: 'tool_calls',
      };
    };
    const session = makeSession(stream, 4_000);
    const res = await session.runUserTurn('read the noise repeatedly');
    expect(res.stopped).toBe('done');
    expect(output).toContain('⏺ context compacted');
    expect(output).toContain('all done');
    const note = session.messages.find(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('SUMMARY-NOTE'),
    );
    expect(note).toBeDefined();
    // conversation got materially smaller than 7 reads of 6k chars
    expect(JSON.stringify(session.messages).length).toBeLessThan(30_000);
  });

  it('a failing summarization call does not break the turn (no user-visible failure)', async () => {
    write(dir, 'noise.txt', 'x'.repeat(5_000));
    let calls = 0;
    const stream = async (req: StreamRequest): Promise<StreamResult> => {
      calls++;
      const last = req.messages.at(-1)!;
      if (last.role === 'user' && (last as { content: string }).content.includes('Summarize the conversation')) {
        throw new Error('summarizer exploded');
      }
      if (calls >= 5) {
        req.onTextDelta?.('finished anyway');
        return { content: 'finished anyway', toolCalls: [], usage: null, durationMs: 1, finishReason: 'stop' };
      }
      return {
        content: '',
        toolCalls: [
          { id: `c${calls}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"noise.txt"}' } },
        ],
        usage: null,
        durationMs: 1,
        finishReason: 'tool_calls',
      };
    };
    const session = makeSession(stream, 2_000);
    const res = await session.runUserTurn('go');
    expect(res.stopped).toBe('done');
    expect(output).toContain('compaction failed; continuing with full context');
    expect(output).toContain('finished anyway');
  });
});
