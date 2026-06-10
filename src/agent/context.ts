import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage, StreamRequest, StreamResult } from '../gateway/client.js';
import { platformShell } from '../tools/shell.js';
import {
  BASE_PERSONA,
  COMPACTION_PROMPT,
  GIT_CONVENTIONS,
  TOOL_RULES,
  environmentBlock,
} from './prompts.js';

/** Walk up from dir looking for a .git entry; null when not in a repo. */
export function findGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function currentGitBranch(gitRoot: string | null): string | null {
  if (!gitRoot) return null;
  try {
    const head = fs.readFileSync(path.join(gitRoot, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    return m ? m[1]! : head.slice(0, 12);
  } catch {
    return null;
  }
}

export interface AgentsFile {
  path: string;
  content: string;
}

/**
 * AGENTS.md chain (SDD §4): walk from cwd up to the git root, collecting an
 * AGENTS.md (fallback CLAUDE.md) from every directory. Nearest LAST, so the
 * most specific instructions carry the highest precedence in the prompt.
 */
export function discoverAgentsFiles(cwd: string, gitRoot: string | null): AgentsFile[] {
  const top = gitRoot ?? cwd;
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  for (;;) {
    dirs.push(dir);
    const rel = path.relative(top, dir);
    if (rel === '' || rel.startsWith('..')) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // dirs is nearest→outermost; reverse for outermost first, nearest last
  dirs.reverse();
  const found: AgentsFile[] = [];
  for (const d of dirs) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const p = path.join(d, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        found.push({ path: p, content: fs.readFileSync(p, 'utf8') });
        break; // AGENTS.md wins over CLAUDE.md within a directory
      }
    }
  }
  return found;
}

export function buildSystemPrompt(cwd: string): string {
  const gitRoot = findGitRoot(cwd);
  const parts = [
    BASE_PERSONA,
    TOOL_RULES,
    GIT_CONVENTIONS,
    environmentBlock({
      os: `${os.type()} ${os.release()} (${process.platform})`,
      cwd,
      gitBranch: currentGitBranch(gitRoot),
      shell: platformShell().shell,
      date: new Date().toISOString().slice(0, 10),
    }),
  ];
  const agents = discoverAgentsFiles(cwd, gitRoot);
  for (const f of agents) {
    parts.push(`## Project instructions from ${f.path}\n\n${f.content.trim()}`);
  }
  return parts.join('\n\n');
}

/** Cheap token estimate: ~4 chars per token over the serialized payload. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += JSON.stringify(m).length;
  }
  return Math.ceil(chars / 4);
}

export interface CompactionDeps {
  stream(req: StreamRequest): Promise<StreamResult>;
  model: string;
}

const KEEP_LAST = 6;

/**
 * Compaction (SDD §4): replace all but the last 6 messages with one assistant
 * summary note produced by a summarization call. The cut never separates an
 * assistant tool_calls message from its tool results.
 */
export async function compactMessages(
  messages: ChatMessage[],
  deps: CompactionDeps,
): Promise<{ compacted: boolean; summary?: string }> {
  if (messages.length < KEEP_LAST + 3) return { compacted: false }; // nothing meaningful to fold
  let cut = messages.length - KEEP_LAST;
  while (cut > 1 && messages[cut]?.role === 'tool') cut--;
  if (cut <= 1) return { compacted: false };

  const toSummarize = messages.slice(1, cut);
  const res = await deps.stream({
    model: deps.model,
    messages: [
      ...messages.slice(0, cut),
      { role: 'user', content: COMPACTION_PROMPT },
    ],
  });
  const summary = res.content.trim() || '(summary unavailable)';
  const note: ChatMessage = {
    role: 'assistant',
    content: `[Context compacted — summary of the earlier conversation (${toSummarize.length} messages)]\n\n${summary}`,
  };
  messages.splice(1, cut - 1, note);
  return { compacted: true, summary };
}
