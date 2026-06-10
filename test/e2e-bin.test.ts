import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTmpDir } from './helpers.js';
import { startSseServer } from './fixtures/sse-server.js';

const BIN = path.resolve(new URL('.', import.meta.url).pathname, '../dist/bin.js');
const CLI = path.resolve(new URL('.', import.meta.url).pathname, '../dist/cli.js');
const hasBuild = fs.existsSync(BIN);
const posix = process.platform !== 'win32';

/**
 * Regression for the silent exit-0 bug: npm installs the bin as a SYMLINK
 * (<prefix>/bin/arks -> .../dist/bin.js), so process.argv[1] is the symlink
 * path while import.meta.url is the realpath. An entry guard comparing the
 * two verbatim never matched, main() never ran, and the process exited 0
 * with no output. These tests invoke the binary the way npm does: by
 * executing the symlink itself, not `node dist/...`.
 */

function runSymlinked(
  link: string,
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // execute the symlink directly — the shebang picks up node, argv[1] = link
    const child = spawn(link, args, {
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe.skipIf(!hasBuild || !posix)('e2e: binary invoked through an npm-style bin symlink', () => {
  let binDir: string;
  let home: string;
  let link: string;

  beforeAll(() => {
    binDir = fs.realpathSync(makeTmpDir('arks-bindir-'));
    home = fs.realpathSync(makeTmpDir('arks-bin-home-'));
    link = path.join(binDir, 'arks');
    fs.chmodSync(BIN, 0o755); // npm marks the bin target executable on install
    fs.symlinkSync(BIN, link);
  });

  afterAll(() => {
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('--help through the symlink prints usage and exits 0', async () => {
    const res = await runSymlinked(link, ['--help'], { ARKS_LLM_KEY: 'k', ARKS_CODE_HOME: home });
    expect(res.stdout).toContain('Usage:');
    expect(res.code).toBe(0);
  });

  it('a REPL session starts through the symlink (header renders, /quit exits 0)', async () => {
    const server = await startSseServer([{ content: 'hello via symlink' }]);
    try {
      const child = spawn(link, [], {
        cwd: home,
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
              child.kill('SIGKILL');
              reject(new Error(`timed out waiting for ${JSON.stringify(marker)} in:\n${stdout}`));
            }
          }, 25);
        });
      await waitFor('ARKS Code v');
      child.stdin.write('/quit\n');
      const code = await new Promise<number | null>((r) => child.on('close', r));
      expect(code).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('startup failure prints to stderr and exits non-zero — silent exit 0 is impossible', async () => {
    const badHome = fs.realpathSync(makeTmpDir('arks-badhome-'));
    try {
      fs.writeFileSync(path.join(badHome, 'config.json'), '{corrupt json');
      const res = await runSymlinked(link, ['--version'], { ARKS_LLM_KEY: 'k', ARKS_CODE_HOME: badHome });
      // --version short-circuits before config; use a real session start instead
      expect(res.code).toBe(0); // sanity: version still works
      const res2 = await runSymlinked(link, ['some task'], { ARKS_LLM_KEY: 'k', ARKS_CODE_HOME: badHome });
      expect(res2.code).not.toBe(0);
      expect(res2.stderr).toContain('Invalid config');
      expect(res2.stdout + res2.stderr).not.toBe('');
    } finally {
      fs.rmSync(badHome, { recursive: true, force: true });
    }
  });

  it('direct `node dist/cli.js --help` still works (realpath-aware direct-run guard)', async () => {
    const res = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, '--help'], {
        env: { ...process.env, NO_COLOR: '1', ARKS_LLM_KEY: 'k', ARKS_CODE_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.on('close', (code) => resolve({ code, stdout }));
    });
    expect(res.stdout).toContain('Usage:');
    expect(res.code).toBe(0);
  });

  it('a symlink to cli.js (the OLD bin target) also works now, not silently exit 0', async () => {
    // belt and braces: even if someone's stale global install still points at
    // cli.js, the realpath-aware guard must run main()
    const oldLink = path.join(binDir, 'arks-old');
    fs.chmodSync(CLI, 0o755);
    fs.symlinkSync(CLI, oldLink);
    const res = await runSymlinked(oldLink, ['--help'], { ARKS_LLM_KEY: 'k', ARKS_CODE_HOME: home });
    expect(res.stdout).toContain('Usage:');
    expect(res.code).toBe(0);
  });
});
