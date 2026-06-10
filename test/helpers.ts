import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '../src/tools/types.js';

export function makeTmpDir(prefix = 'arks-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeCtx(dir: string): ToolContext {
  return { cwd: dir, repoRoot: dir, todos: [] };
}

export function write(dir: string, rel: string, content: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}
