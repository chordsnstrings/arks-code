import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_OUTPUT_CHARS, bashTool, platformShell, truncateOutput } from '../src/tools/shell.js';
import type { ToolContext } from '../src/tools/types.js';
import { makeCtx, makeTmpDir } from './helpers.js';

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = makeTmpDir();
  ctx = makeCtx(fs.realpathSync(dir));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('platformShell', () => {
  it('uses $SHELL when set on posix', () => {
    const info = platformShell({ SHELL: '/bin/zsh' }, 'linux');
    expect(info).toEqual({ shell: '/bin/zsh', args: ['-c'], kind: 'posix' });
  });

  it('defaults to /bin/bash on posix', () => {
    expect(platformShell({}, 'darwin').shell).toBe('/bin/bash');
  });

  it('defaults to powershell.exe on windows unless SHELL is set (CLAUDE.md landmine)', () => {
    const win = platformShell({}, 'win32');
    expect(win.shell).toBe('powershell.exe');
    expect(win.kind).toBe('powershell');
    const bashOnWin = platformShell({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' }, 'win32');
    expect(bashOnWin.kind).toBe('posix');
  });
});

describe('bash tool', () => {
  it('captures stdout and reports nonzero exit codes', async () => {
    const out = await bashTool.execute({ command: 'echo hello && exit 3' }, ctx);
    expect(out).toContain('hello');
    expect(out).toContain('[exit code 3]');
  });

  it('interleaves stderr with stdout', async () => {
    const out = await bashTool.execute({ command: 'echo out; echo err 1>&2' }, ctx);
    expect(out).toContain('out');
    expect(out).toContain('err');
  });

  it('persists cwd across calls (cd sticks)', async () => {
    fs.mkdirSync(`${ctx.cwd}/subdir`);
    await bashTool.execute({ command: 'cd subdir' }, ctx);
    expect(ctx.cwd.endsWith('subdir')).toBe(true);
    const out = await bashTool.execute({ command: 'pwd' }, ctx);
    expect(out).toContain('subdir');
  });

  it('kills the command on timeout and says so', async () => {
    const out = await bashTool.execute({ command: 'sleep 30', timeout: 1 }, ctx);
    expect(out).toContain('timed out after 1s');
  }, 10_000);

  it('head+tail truncates output over 30k chars', async () => {
    const out = await bashTool.execute(
      { command: `node -e "process.stdout.write('a'.repeat(20000)+'MIDDLE'+'b'.repeat(20000))"` },
      ctx,
    );
    expect(out.length).toBeLessThan(MAX_OUTPUT_CHARS + 200);
    expect(out).toContain('characters truncated');
    expect(out.startsWith('a')).toBe(true);
    expect(out.trimEnd().endsWith('b')).toBe(true);
    expect(out).not.toContain('MIDDLE');
  });

  it('returns (no output) for silent commands', async () => {
    const out = await bashTool.execute({ command: 'true' }, ctx);
    expect(out).toBe('(no output)');
  });

  it('returns an error string for empty commands', async () => {
    expect(await bashTool.execute({ command: '  ' }, ctx)).toMatch(/^Error/);
  });
});

describe('truncateOutput', () => {
  it('passes short output through untouched', () => {
    expect(truncateOutput('short')).toBe('short');
  });

  it('keeps head and tail', () => {
    const text = 'H'.repeat(20_000) + 'T'.repeat(20_000);
    const out = truncateOutput(text);
    expect(out.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 100);
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
  });
});
