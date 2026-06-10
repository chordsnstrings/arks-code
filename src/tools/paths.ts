import * as path from 'node:path';
import type { ToolContext } from './types.js';

/** Resolve a tool-supplied path against the session cwd (SDD §3). */
export function resolveToolPath(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.cwd, p);
}

/** True when an absolute resolved path falls outside the repo root. */
export function isOutsideRepoRoot(ctx: ToolContext, resolved: string): boolean {
  const rel = path.relative(ctx.repoRoot, resolved);
  return rel.startsWith('..') || path.isAbsolute(rel);
}
