import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Minimal .gitignore support for glob/grep traversal: comments, blank lines,
 * negation (!), directory suffix (/), root anchoring (leading /), * ? and **
 * wildcards. Plus hard-coded skips for .git and node_modules.
 */

interface IgnoreRule {
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

const HARD_SKIP = new Set(['.git', 'node_modules']);

function patternToRegex(pattern: string, anchored: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++; // "**/" matches zero or more dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const prefix = anchored ? '^' : '(^|/)';
  return new RegExp(`${prefix}${re}(/|$)`);
}

export class GitIgnore {
  private rules: IgnoreRule[] = [];

  static fromDir(root: string): GitIgnore {
    const gi = new GitIgnore();
    const file = path.join(root, '.gitignore');
    if (fs.existsSync(file)) gi.addPatterns(fs.readFileSync(file, 'utf8').split('\n'));
    return gi;
  }

  addPatterns(lines: string[]): void {
    for (let line of lines) {
      line = line.replace(/\r$/, '');
      if (!line.trim() || line.startsWith('#')) continue;
      let negated = false;
      if (line.startsWith('!')) {
        negated = true;
        line = line.slice(1);
      }
      let dirOnly = false;
      if (line.endsWith('/')) {
        dirOnly = true;
        line = line.slice(0, -1);
      }
      let anchored = false;
      if (line.startsWith('/')) {
        anchored = true;
        line = line.slice(1);
      } else if (line.slice(0, -1).includes('/')) {
        // a slash anywhere (except trailing) anchors the pattern in git
        anchored = true;
      }
      this.rules.push({ regex: patternToRegex(line, anchored), negated, dirOnly });
    }
  }

  /** @param relPath posix-style path relative to the ignore root */
  ignores(relPath: string, isDir = false): boolean {
    const base = relPath.split('/').pop() ?? relPath;
    if (HARD_SKIP.has(base)) return true;
    let ignored = false;
    for (const rule of this.rules) {
      const m = rule.regex.exec(relPath);
      if (!m) continue;
      if (rule.dirOnly && !isDir) {
        // A dir-only pattern ("dist/") must not match a plain *file* of the
        // same name; it still matches files under that dir via a mid-path
        // segment (the match then ends with '/').
        const matchEndsAtPathEnd = m.index + m[0].length === relPath.length;
        if (matchEndsAtPathEnd && !m[0].endsWith('/')) continue;
      }
      ignored = !rule.negated;
    }
    return ignored;
  }
}

export interface WalkOptions {
  /** Maximum entries to visit, as a safety valve. */
  maxEntries?: number;
}

/** Recursively list files under root, honoring .gitignore. Posix rel paths. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const ignore = GitIgnore.fromDir(root);
  const max = opts.maxEntries ?? 50_000;
  const out: string[] = [];
  const stack: string[] = [''];
  let visited = 0;
  while (stack.length > 0 && visited < max) {
    const rel = stack.pop()!;
    const abs = path.join(root, rel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      visited++;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ignore.ignores(childRel, true)) stack.push(childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (!ignore.ignores(childRel, false)) out.push(childRel);
      }
    }
  }
  return out;
}
