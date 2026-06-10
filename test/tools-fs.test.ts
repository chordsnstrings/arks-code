import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editFileTool, globTool, globToRegex, readFileTool, simpleDiff, writeFileTool } from '../src/tools/fs.js';
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

describe('read_file', () => {
  it('returns numbered lines', async () => {
    write(dir, 'a.txt', 'alpha\nbeta\ngamma');
    const out = await readFileTool.execute({ path: 'a.txt' }, ctx);
    expect(out).toBe('1\talpha\n2\tbeta\n3\tgamma');
  });

  it('honors offset and limit', async () => {
    write(dir, 'a.txt', Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const out = await readFileTool.execute({ path: 'a.txt', offset: 4, limit: 2 }, ctx);
    expect(out).toContain('4\tline4');
    expect(out).toContain('5\tline5');
    expect(out).not.toContain('line6');
    expect(out).toContain('[File has 10 lines; showing 4-5.');
  });

  it('slices files over 2000 lines with a note', async () => {
    write(dir, 'big.txt', Array.from({ length: 2500 }, (_, i) => `l${i + 1}`).join('\n'));
    const out = await readFileTool.execute({ path: 'big.txt' }, ctx);
    expect(out).toContain('2000\tl2000');
    expect(out).not.toContain('\tl2001');
    expect(out).toContain('File has 2500 lines; showing 1-2000');
  });

  it('refuses binary files with type info', async () => {
    fs.writeFileSync(path.join(dir, 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const out = await readFileTool.execute({ path: 'blob.png' }, ctx);
    expect(out).toMatch(/^Error: .*binary file/);
    expect(out).toContain('.png');
  });

  it('returns an error string (not a throw) for missing files', async () => {
    const out = await readFileTool.execute({ path: 'nope.txt' }, ctx);
    expect(out).toMatch(/^Error: file not found/);
  });
});

describe('write_file', () => {
  it('creates parent directories as needed', async () => {
    const out = await writeFileTool.execute({ path: 'deep/nested/f.txt', content: 'hi\nthere' }, ctx);
    expect(out).toContain('Wrote 2 lines');
    expect(fs.readFileSync(path.join(dir, 'deep/nested/f.txt'), 'utf8')).toBe('hi\nthere');
  });

  it('is gated as fileWrite and previews new content as +lines', () => {
    expect(writeFileTool.gate).toBe('fileWrite');
    const preview = writeFileTool.preview!({ path: 'new.txt', content: 'a\nb' }, ctx);
    expect(preview).toBe('+ a\n+ b');
  });

  it('previews overwrites as a diff', () => {
    write(dir, 'f.txt', 'one\ntwo\nthree');
    const preview = writeFileTool.preview!({ path: 'f.txt', content: 'one\nTWO\nthree' }, ctx);
    expect(preview).toContain('- two');
    expect(preview).toContain('+ TWO');
  });
});

describe('edit_file uniqueness (whitespace-exact)', () => {
  it('replaces a unique match', async () => {
    write(dir, 'f.ts', 'const a = 1;\nconst b = 2;\n');
    const out = await editFileTool.execute(
      { path: 'f.ts', old_str: 'const b = 2;', new_str: 'const b = 42;' },
      ctx,
    );
    expect(out).toContain('Edited');
    expect(fs.readFileSync(path.join(dir, 'f.ts'), 'utf8')).toBe('const a = 1;\nconst b = 42;\n');
  });

  it('rejects zero matches and tells the model to re-read', async () => {
    write(dir, 'f.ts', 'const a = 1;\n');
    const out = await editFileTool.execute(
      { path: 'f.ts', old_str: 'const a=1;', new_str: 'x' }, // wrong whitespace
      ctx,
    );
    expect(out).toMatch(/^Error: old_str not found/);
    expect(out).toContain('re-read');
    expect(fs.readFileSync(path.join(dir, 'f.ts'), 'utf8')).toBe('const a = 1;\n'); // untouched
  });

  it('rejects multiple matches with the count', async () => {
    write(dir, 'f.ts', 'x = 1\nx = 1\n');
    const out = await editFileTool.execute({ path: 'f.ts', old_str: 'x = 1', new_str: 'y' }, ctx);
    expect(out).toMatch(/^Error: old_str matches 2 times/);
  });

  it('rejects empty old_str', async () => {
    write(dir, 'f.ts', 'abc');
    const out = await editFileTool.execute({ path: 'f.ts', old_str: '', new_str: 'y' }, ctx);
    expect(out).toMatch(/^Error/);
  });

  it('previews as -old/+new lines', () => {
    const preview = editFileTool.preview!({ path: 'f', old_str: 'a\nb', new_str: 'c' }, ctx);
    expect(preview).toBe('- a\n- b\n+ c');
  });
});

describe('glob', () => {
  it('matches **/ patterns and sorts by mtime desc', async () => {
    write(dir, 'src/a.ts', 'a');
    write(dir, 'src/sub/b.ts', 'b');
    write(dir, 'src/c.js', 'c');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'src/sub/b.ts'), past, past);
    const out = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('src/a.ts'); // newer first
    expect(lines[1]).toBe('src/sub/b.ts');
  });

  it('respects .gitignore', async () => {
    write(dir, '.gitignore', 'dist/\n*.log\n');
    write(dir, 'dist/out.ts', 'x');
    write(dir, 'src/keep.ts', 'x');
    write(dir, 'debug.log', 'x');
    const out = await globTool.execute({ pattern: '**/*' }, ctx);
    expect(out).toContain('src/keep.ts');
    expect(out).not.toContain('dist/out.ts');
    expect(out).not.toContain('debug.log');
  });

  it('reports when nothing matches', async () => {
    const out = await globTool.execute({ pattern: '*.zig' }, ctx);
    expect(out).toBe('No files matched.');
  });
});

describe('globToRegex', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', true], // no slash → any depth
    ['*.ts', 'a.tsx', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/x/y/a.ts', true],
    ['src/**/*.ts', 'lib/a.ts', false],
    ['src/**', 'src/anything/deep.txt', true],
    ['?.md', 'a.md', true],
    ['?.md', 'ab.md', false],
    ['*.{ts,tsx}', 'a.tsx', true],
    ['*.{ts,tsx}', 'a.js', false],
  ])('%s vs %s → %s', (pattern, file, expected) => {
    expect(globToRegex(pattern).test(file)).toBe(expected);
  });
});

describe('simpleDiff', () => {
  it('shows only the changed region with one line of context', () => {
    const d = simpleDiff('a\nb\nc\nd', 'a\nB\nc\nd');
    expect(d).toBe('  a\n- b\n+ B\n  c');
  });
});
