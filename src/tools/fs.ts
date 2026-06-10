import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkFiles } from './ignore.js';
import { resolveToolPath } from './paths.js';
import type { RegisteredTool, ToolContext } from './types.js';

const MAX_LINES = 2000;

function isBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}

function numberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width)}\t${l}`).join('\n');
}

function relForDisplay(ctx: ToolContext, abs: string): string {
  const rel = path.relative(ctx.cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

export const readFileTool: RegisteredTool = {
  gate: null,
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file, returning numbered lines. Use offset/limit for large files. ' +
        'Files over 2000 lines return the first slice plus a note. Binary files are refused.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, relative to the working directory or absolute.' },
          offset: { type: 'integer', description: '1-based line number to start from.' },
          limit: { type: 'integer', description: 'Maximum number of lines to return.' },
        },
        required: ['path'],
      },
    },
  },
  summarize(args, ctx) {
    return `read ${relForDisplay(ctx, resolveToolPath(ctx, String(args.path ?? '')))}`;
  },
  async execute(args, ctx) {
    const p = resolveToolPath(ctx, String(args.path ?? ''));
    const stat = fs.statSync(p, { throwIfNoEntry: false });
    if (!stat) return `Error: file not found: ${p}`;
    if (stat.isDirectory()) return `Error: ${p} is a directory`;
    const buf = fs.readFileSync(p);
    if (isBinary(buf)) {
      return `Error: ${p} appears to be a binary file (${path.extname(p) || 'no extension'}, ${stat.size} bytes). Refusing to read it as text.`;
    }
    const allLines = buf.toString('utf8').split('\n');
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.min(Number(args.limit ?? MAX_LINES), MAX_LINES);
    const slice = allLines.slice(offset - 1, offset - 1 + limit);
    let out = numberLines(slice, offset);
    if (offset - 1 + slice.length < allLines.length) {
      out += `\n\n[File has ${allLines.length} lines; showing ${offset}-${offset - 1 + slice.length}. Use offset/limit to read more.]`;
    }
    return out;
  },
};

export const writeFileTool: RegisteredTool = {
  gate: 'fileWrite',
  definition: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file, creating it (and parent directories) if needed, or fully overwriting it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write.' },
          content: { type: 'string', description: 'Full file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  summarize(args, ctx) {
    return `write ${relForDisplay(ctx, resolveToolPath(ctx, String(args.path ?? '')))}`;
  },
  preview(args, ctx) {
    const p = resolveToolPath(ctx, String(args.path ?? ''));
    const content = String(args.content ?? '');
    const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (existing === null) {
      return content
        .split('\n')
        .map((l) => `+ ${l}`)
        .join('\n');
    }
    return simpleDiff(existing, content);
  },
  async execute(args, ctx) {
    const p = resolveToolPath(ctx, String(args.path ?? ''));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const content = String(args.content ?? '');
    fs.writeFileSync(p, content, 'utf8');
    return `Wrote ${content.split('\n').length} lines to ${p}`;
  },
};

export const editFileTool: RegisteredTool = {
  gate: 'fileWrite',
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace one exact, unique occurrence of old_str with new_str in a file. Matching is ' +
        'whitespace-exact (indentation and line endings must match the file precisely), so ' +
        're-read the file with read_file immediately before editing. If old_str matches zero ' +
        'or multiple times the edit is rejected — include more surrounding context to make it unique.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit.' },
          old_str: { type: 'string', description: 'Exact text to replace; must occur exactly once.' },
          new_str: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  summarize(args, ctx) {
    return `edit ${relForDisplay(ctx, resolveToolPath(ctx, String(args.path ?? '')))}`;
  },
  preview(args) {
    const oldStr = String(args.old_str ?? '');
    const newStr = String(args.new_str ?? '');
    return [
      ...oldStr.split('\n').map((l) => `- ${l}`),
      ...newStr.split('\n').map((l) => `+ ${l}`),
    ].join('\n');
  },
  async execute(args, ctx) {
    const p = resolveToolPath(ctx, String(args.path ?? ''));
    if (!fs.existsSync(p)) return `Error: file not found: ${p}`;
    const content = fs.readFileSync(p, 'utf8');
    const oldStr = String(args.old_str ?? '');
    const newStr = String(args.new_str ?? '');
    if (oldStr.length === 0) return 'Error: old_str must not be empty.';
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return `Error: old_str not found in ${p}. Matching is whitespace-exact — re-read the file with read_file and copy the text precisely.`;
    }
    if (count > 1) {
      return `Error: old_str matches ${count} times in ${p}; it must match exactly once. Re-read the file and include more surrounding context to make it unique.`;
    }
    fs.writeFileSync(p, content.replace(oldStr, newStr), 'utf8');
    return `Edited ${p}`;
  },
};

export const globTool: RegisteredTool = {
  gate: null,
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files matching a glob pattern (e.g. "src/**/*.ts"). Results are sorted by ' +
        'modification time, newest first. Respects .gitignore.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern. Supports *, ?, ** and {a,b} alternates.' },
          path: { type: 'string', description: 'Directory to search in (default: working directory).' },
        },
        required: ['pattern'],
      },
    },
  },
  summarize(args) {
    return `glob ${String(args.pattern ?? '')}`;
  },
  async execute(args, ctx) {
    const root = resolveToolPath(ctx, String(args.path ?? '.'));
    if (!fs.existsSync(root)) return `Error: directory not found: ${root}`;
    const regex = globToRegex(String(args.pattern ?? ''));
    const matches = walkFiles(root).filter((rel) => regex.test(rel));
    const withTimes = matches.map((rel) => {
      const stat = fs.statSync(path.join(root, rel), { throwIfNoEntry: false });
      return { rel, mtime: stat?.mtimeMs ?? 0 };
    });
    withTimes.sort((a, b) => b.mtime - a.mtime);
    if (withTimes.length === 0) return 'No files matched.';
    return withTimes.map((m) => m.rel).join('\n');
  },
};

/** Convert a glob pattern to a regex over posix-style relative paths. */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') i++;
        re += '(?:.*/)?';
        // bare "**" at end matches everything below
        if (i === pattern.length - 1 || (pattern[i] === '/' && i + 1 === pattern.length)) re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // A pattern without a slash matches at any depth (like git/rg behavior).
  const prefix = pattern.includes('/') ? '^' : '(?:^|/)';
  return new RegExp(`${prefix}${re}$`);
}

/** Naive line diff for approval previews: shows removed/added lines only. */
export function simpleDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  // trim common prefix/suffix for a compact, readable preview
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA).map((l) => `- ${l}`);
  const added = b.slice(start, endB).map((l) => `+ ${l}`);
  if (removed.length === 0 && added.length === 0) return '(no changes)';
  const ctxBefore = start > 0 ? [`  ${a[start - 1]}`] : [];
  const ctxAfter = endA < a.length ? [`  ${a[endA]}`] : [];
  return [...ctxBefore, ...removed, ...added, ...ctxAfter].join('\n');
}
