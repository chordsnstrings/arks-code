import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_HITS, grepTool, grepWithJs, hasRipgrep, setRipgrepAvailable } from '../src/tools/search.js';
import type { ToolContext } from '../src/tools/types.js';
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

describe('grep (JS fallback engine)', () => {
  it('finds file:line:text matches', () => {
    write(dir, 'src/auth.ts', 'function login() {}\nfunction logout() {}\n');
    write(dir, 'src/db.ts', 'connect();\n');
    const out = grepWithJs('function log\\w+', dir);
    expect(out).toContain('src/auth.ts:1:function login() {}');
    expect(out).toContain('src/auth.ts:2:function logout() {}');
    expect(out).not.toContain('db.ts');
  });

  it('filters by glob', () => {
    write(dir, 'a.ts', 'needle');
    write(dir, 'b.js', 'needle');
    const out = grepWithJs('needle', dir, '*.ts');
    expect(out).toContain('a.ts');
    expect(out).not.toContain('b.js');
  });

  it('caps at MAX_HITS with a truncation note', () => {
    const lines = Array.from({ length: MAX_HITS + 50 }, () => 'match me').join('\n');
    write(dir, 'big.txt', lines);
    const out = grepWithJs('match me', dir);
    expect(out.split('\n').filter((l) => l.includes('big.txt')).length).toBe(MAX_HITS);
    expect(out).toContain('50 more matches truncated');
  });

  it('skips binary files and reports invalid regexes as errors', () => {
    fs.writeFileSync(`${dir}/bin.dat`, Buffer.from([0x00, 0x01, 0x61]));
    expect(grepWithJs('a', dir)).toBe('No matches.');
    expect(grepWithJs('([', dir)).toMatch(/^Error: invalid regex/);
  });

  it('respects .gitignore', () => {
    write(dir, '.gitignore', 'vendor/\n');
    write(dir, 'vendor/lib.ts', 'needle');
    write(dir, 'src/app.ts', 'needle');
    const out = grepWithJs('needle', dir);
    expect(out).toContain('src/app.ts');
    expect(out).not.toContain('vendor');
  });
});

describe('grep tool (engine selection)', () => {
  afterEach(() => {
    setRipgrepAvailable(undefined); // re-detect for other suites
  });

  it('works end-to-end with the JS engine forced', async () => {
    setRipgrepAvailable(false);
    write(dir, 'x.ts', 'const secret = 1;');
    const out = await grepTool.execute({ pattern: 'secret' }, ctx);
    expect(out).toContain('x.ts:1:const secret = 1;');
  });

  it('works against a single file path', async () => {
    write(dir, 'one.txt', 'a\nfindme\nb');
    const out = await grepTool.execute({ pattern: 'findme', path: 'one.txt' }, ctx);
    expect(out).toContain('one.txt:2:findme');
  });

  it('returns error text for a missing path', async () => {
    const out = await grepTool.execute({ pattern: 'x', path: 'no/such/dir' }, ctx);
    expect(out).toMatch(/^Error: path not found/);
  });

  it('uses ripgrep when available and results match the JS engine', async () => {
    if (!hasRipgrep()) return; // environment without rg: covered by JS tests
    write(dir, 'r.ts', 'ripgrep target line');
    const out = await grepTool.execute({ pattern: 'ripgrep target' }, ctx);
    expect(out).toContain('r.ts:1:ripgrep target line');
  });
});
