import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compactMessages,
  currentGitBranch,
  discoverAgentsFiles,
  estimateTokens,
  findGitRoot,
} from '../src/agent/context.js';
import type { ChatMessage } from '../src/gateway/client.js';
import { MockGateway } from './fixtures/mock-gateway.js';
import { makeTmpDir, write } from './helpers.js';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(makeTmpDir());
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('findGitRoot / currentGitBranch', () => {
  it('finds the git root from a nested dir', () => {
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    expect(findGitRoot(path.join(dir, 'a/b'))).toBe(dir);
  });

  it('returns null outside a repo', () => {
    expect(findGitRoot(dir)).toBeNull();
  });

  it('reads the branch from .git/HEAD', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref: refs/heads/feature/login\n');
    expect(currentGitBranch(dir)).toBe('feature/login');
  });
});

describe('discoverAgentsFiles (GOALS criterion 5)', () => {
  it('collects AGENTS.md from cwd up to git root, nearest last', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    write(dir, 'AGENTS.md', 'root rules');
    write(dir, 'pkg/sub/AGENTS.md', 'sub rules');
    fs.mkdirSync(path.join(dir, 'pkg/sub'), { recursive: true });
    const files = discoverAgentsFiles(path.join(dir, 'pkg/sub'), dir);
    expect(files.map((f) => f.content)).toEqual(['root rules', 'sub rules']);
  });

  it('falls back to CLAUDE.md per directory, with AGENTS.md taking precedence', () => {
    fs.mkdirSync(path.join(dir, '.git'));
    write(dir, 'CLAUDE.md', 'claude root');
    write(dir, 'pkg/AGENTS.md', 'agents pkg');
    write(dir, 'pkg/CLAUDE.md', 'claude pkg (should lose)');
    const files = discoverAgentsFiles(path.join(dir, 'pkg'), dir);
    expect(files.map((f) => f.content)).toEqual(['claude root', 'agents pkg']);
  });

  it('does not walk above the git root', () => {
    write(dir, 'AGENTS.md', 'outside repo — must not load');
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    write(dir, 'repo/AGENTS.md', 'inside');
    const files = discoverAgentsFiles(repo, repo);
    expect(files.map((f) => f.content)).toEqual(['inside']);
  });

  it('uses just cwd when not in a git repo', () => {
    write(dir, 'AGENTS.md', 'standalone');
    const files = discoverAgentsFiles(dir, null);
    expect(files.map((f) => f.content)).toEqual(['standalone']);
  });
});

describe('estimateTokens', () => {
  it('estimates ~chars/4 over serialized messages', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'x'.repeat(4000) }];
    const est = estimateTokens(messages);
    expect(est).toBeGreaterThan(900);
    expect(est).toBeLessThan(1200);
  });
});

describe('compactMessages (GOALS criterion 6)', () => {
  function conversation(n: number): ChatMessage[] {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < n; i++) {
      msgs.push({ role: 'user', content: `question ${i}` });
      msgs.push({ role: 'assistant', content: `answer ${i}` });
    }
    return msgs;
  }

  it('replaces older turns with a summary note, keeping system + last 6', async () => {
    const gw = new MockGateway([{ content: 'Did A, touched b.ts, next: C.' }]);
    const messages = conversation(10); // 21 messages
    const res = await compactMessages(messages, { stream: gw.stream, model: 'code-fast' });
    expect(res.compacted).toBe(true);
    expect(messages[0]!.role).toBe('system');
    expect(messages[1]!.role).toBe('assistant');
    expect((messages[1] as { content: string }).content).toContain('Context compacted');
    expect((messages[1] as { content: string }).content).toContain('Did A, touched b.ts');
    expect(messages.length).toBe(2 + 6); // system + note + last 6
    expect((messages.at(-1) as { content: string }).content).toBe('answer 9');
  });

  it('never cuts between an assistant tool_calls message and its tool results', async () => {
    const gw = new MockGateway([{ content: 'summary' }]);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'glob', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'u4' },
      { role: 'assistant', content: 'a4' },
    ];
    await compactMessages(messages, { stream: gw.stream, model: 'code-fast' });
    // wherever the cut landed, no tool message may appear without its assistant
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'tool') {
        const prev = messages[i - 1] as { role: string; tool_calls?: unknown[] };
        const prevPrev = messages[i - 2] as { role: string; tool_calls?: unknown[] } | undefined;
        expect(prev.role === 'assistant' || prev.role === 'tool').toBe(true);
        expect(prev.tool_calls ?? prevPrev?.tool_calls).toBeDefined();
      }
    }
  });

  it('declines to compact tiny conversations', async () => {
    const gw = new MockGateway([{ content: 'should not be called' }]);
    const messages = conversation(2);
    const res = await compactMessages(messages, { stream: gw.stream, model: 'code-fast' });
    expect(res.compacted).toBe(false);
    expect(gw.requests).toHaveLength(0);
  });
});
