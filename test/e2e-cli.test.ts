import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTmpDir, write } from './helpers.js';
import { startSseServer, type ServerScriptStep } from './fixtures/sse-server.js';

const CLI = path.resolve(new URL('.', import.meta.url).pathname, '../dist/cli.js');

/**
 * End-to-end: the BUILT cli (dist/cli.js) against a real local HTTP server
 * speaking SSE with fragmented tool-call deltas. Requires `npm run build`
 * first; skipped when dist/ is absent (e.g. a unit-only run).
 */
const hasBuild = fs.existsSync(CLI);

function runCli(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: '1', ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!hasBuild)('e2e: built CLI against a live mock gateway', () => {
  let dir: string;
  let home: string;

  beforeAll(() => {
    dir = fs.realpathSync(makeTmpDir('arks-e2e-'));
    home = fs.realpathSync(makeTmpDir('arks-e2e-home-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('one-shot mode completes a tool-using task and exits 0 (GOALS criterion 1)', async () => {
    write(dir, 'data.txt', 'the answer is 42');
    const script: ServerScriptStep[] = [
      { content: 'Let me look.', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'data.txt' } }] },
      { content: 'The file says: the answer is 42.' },
    ];
    const server = await startSseServer(script);
    try {
      const res = await runCli(['--yolo', 'what does data.txt say?'], {
        cwd: dir,
        env: {
          ARKS_LLM_KEY: 'test-key',
          ARKS_LLM_BASE_URL: server.url,
          ARKS_CODE_HOME: home,
        },
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Let me look.');
      expect(res.stdout).toContain('⏺ read data.txt ✓');
      expect(res.stdout).toContain('The file says: the answer is 42.');
    } finally {
      await server.close();
    }
  });

  it('writes a ledger record per model call (GOALS criterion 7)', async () => {
    const ledgerDir = path.join(home, 'ledger');
    const files = fs.readdirSync(ledgerDir);
    expect(files).toHaveLength(1);
    const lines = fs
      .readFileSync(path.join(ledgerDir, files[0]!), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThanOrEqual(2); // two model calls in the previous test
    expect(lines[0]).toMatchObject({ model: 'code-fast', prompt_tokens: 50, completion_tokens: 10 });
    expect(typeof lines[0]!.cost_usd).toBe('number');
  });

  it('REPL mode: header, streaming turn, /cost and /quit (criterion 1 + 7)', async () => {
    const server = await startSseServer([{ content: 'Hello from the REPL.' }]);
    const child = spawn(process.execPath, [CLI], {
      cwd: dir,
      env: {
        ...process.env,
        NO_COLOR: '1',
        ARKS_LLM_KEY: 'k',
        ARKS_LLM_BASE_URL: server.url,
        ARKS_CODE_HOME: home,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    const waitFor = (marker: string) =>
      new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (stdout.includes(marker)) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - t0 > 15_000) {
            clearInterval(poll);
            reject(new Error(`timed out waiting for ${JSON.stringify(marker)} in:\n${stdout}`));
          }
        }, 25);
      });
    try {
      await waitFor('ARKS Code v0.1.0');
      child.stdin.write('say hello\n');
      await waitFor('Hello from the REPL.');
      child.stdin.write('/cost\n');
      await waitFor('Month to date:');
      expect(stdout).toContain('Session: 1 calls');
      child.stdin.write('/quit\n');
      const code = await new Promise<number | null>((r) => child.on('close', r));
      expect(code).toBe(0);
    } finally {
      child.kill('SIGKILL');
      await server.close();
    }
  });

  it('gated one-shot: approval prompt appears, piped "y" approves the write (criterion 4)', async () => {
    const server = await startSseServer([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'approved.txt', content: 'bonjour' } }] },
      { content: 'Wrote it.' },
    ]);
    try {
      const res = await runCli(['write a greeting file'], {
        cwd: dir,
        env: { ARKS_LLM_KEY: 'k', ARKS_LLM_BASE_URL: server.url, ARKS_CODE_HOME: home },
        stdin: 'y\n',
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('── WRITE approved.txt');
      expect(res.stdout).toContain('+ bonjour');
      expect(res.stdout).toContain('Apply? [y]es [n]o');
      expect(fs.readFileSync(path.join(dir, 'approved.txt'), 'utf8')).toBe('bonjour');
    } finally {
      await server.close();
    }
  });

  it('gated one-shot: piped "n" denies and nothing is written', async () => {
    const server = await startSseServer([
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'denied.txt', content: 'non' } }] },
      { content: 'Understood.' },
    ]);
    try {
      const res = await runCli(['write a file'], {
        cwd: dir,
        env: { ARKS_LLM_KEY: 'k', ARKS_LLM_BASE_URL: server.url, ARKS_CODE_HOME: home },
        stdin: 'n\n',
      });
      expect(res.code).toBe(0);
      expect(fs.existsSync(path.join(dir, 'denied.txt'))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('fails fast with a clear message when ARKS_LLM_KEY is missing', async () => {
    const res = await runCli(['task'], {
      cwd: dir,
      env: { ARKS_LLM_BASE_URL: 'http://127.0.0.1:9/v1', ARKS_CODE_HOME: home, ARKS_LLM_KEY: '' },
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('ARKS_LLM_KEY');
  });

  it('surfaces gateway 4xx verbatim with exit code 1', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"bad api key"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    try {
      const res = await runCli(['task'], {
        cwd: dir,
        env: {
          ARKS_LLM_KEY: 'bad',
          ARKS_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
          ARKS_CODE_HOME: home,
        },
      });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('bad api key');
    } finally {
      server.close();
    }
  });
});
