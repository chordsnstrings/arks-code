import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { globToRegex } from './fs.js';
import { walkFiles } from './ignore.js';
import { resolveToolPath } from './paths.js';
import type { RegisteredTool } from './types.js';

export const MAX_HITS = 200;

let rgAvailable: boolean | undefined;

/** Test hook: force the detection result, or pass undefined to re-detect. */
export function setRipgrepAvailable(value: boolean | undefined): void {
  rgAvailable = value;
}

export function hasRipgrep(): boolean {
  if (rgAvailable === undefined) {
    try {
      const res = spawnSync('rg', ['--version'], { stdio: 'ignore' });
      rgAvailable = res.status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

export function grepWithRipgrep(pattern: string, root: string, glob?: string): string {
  const args = ['--no-config', '--line-number', '--no-heading', '--color', 'never', '-e', pattern];
  if (glob) args.push('--glob', glob);
  args.push('.');
  const res = spawnSync('rg', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw res.error;
  if (res.status !== 0 && res.status !== 1) {
    return `Error: ripgrep failed: ${(res.stderr || '').trim()}`;
  }
  const lines = (res.stdout || '').split('\n').filter(Boolean);
  if (lines.length === 0) return 'No matches.';
  const shown = lines.slice(0, MAX_HITS).map((l) => l.replace(/^\.[/\\]/, ''));
  let out = shown.join('\n');
  if (lines.length > MAX_HITS) out += `\n[${lines.length - MAX_HITS} more matches truncated; refine the pattern]`;
  return out;
}

export function grepWithJs(pattern: string, root: string, glob?: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return `Error: invalid regex: ${(err as Error).message}`;
  }
  const globRegex = glob ? globToRegex(glob) : undefined;
  const hits: string[] = [];
  let total = 0;
  for (const rel of walkFiles(root)) {
    if (globRegex && !globRegex.test(rel)) continue;
    let content: string;
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      content = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        total++;
        if (hits.length < MAX_HITS) hits.push(`${rel}:${i + 1}:${lines[i]}`);
      }
    }
  }
  if (total === 0) return 'No matches.';
  let out = hits.join('\n');
  if (total > MAX_HITS) out += `\n[${total - MAX_HITS} more matches truncated; refine the pattern]`;
  return out;
}

export const grepTool: RegisteredTool = {
  gate: null,
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents with a regular expression. Returns file:line:text matches, ' +
        `up to ${MAX_HITS} hits. Uses ripgrep when available.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: { type: 'string', description: 'Directory or file to search (default: working directory).' },
          glob: { type: 'string', description: 'Restrict to files matching this glob, e.g. "*.ts".' },
        },
        required: ['pattern'],
      },
    },
  },
  summarize(args) {
    return `grep ${String(args.pattern ?? '')}`;
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return 'Error: pattern is required.';
    const root = resolveToolPath(ctx, String(args.path ?? '.'));
    if (!fs.existsSync(root)) return `Error: path not found: ${root}`;
    const glob = args.glob ? String(args.glob) : undefined;
    if (fs.statSync(root).isFile()) return grepSingleFile(pattern, root);
    try {
      return hasRipgrep() ? grepWithRipgrep(pattern, root, glob) : grepWithJs(pattern, root, glob);
    } catch {
      return grepWithJs(pattern, root, glob);
    }
  },
};

function grepSingleFile(pattern: string, file: string): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return `Error: invalid regex: ${(err as Error).message}`;
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
    if (regex.test(lines[i]!)) hits.push(`${path.basename(file)}:${i + 1}:${lines[i]}`);
  }
  return hits.length > 0 ? hits.join('\n') : 'No matches.';
}
