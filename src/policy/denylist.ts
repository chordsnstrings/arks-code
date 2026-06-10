import * as path from 'node:path';

/**
 * Destructive command patterns (SDD §5). Security-critical: every pattern has
 * a positive and a negative test case (CLAUDE.md rule 4). A deny-list hit
 * ALWAYS requires explicit confirmation, even under --yolo / always-allow.
 */

export interface DenyPattern {
  name: string;
  description: string;
  regex: RegExp;
}

export const DENY_PATTERNS: DenyPattern[] = [
  {
    name: 'git-push-force',
    description: 'force push rewrites remote history',
    regex: /\bgit\b[^\n|;&]*\bpush\b[^\n|;&]*(\s--force(-with-lease(=\S*)?)?\b|\s-f\b)/,
  },
  {
    name: 'git-reset-hard',
    description: 'hard reset discards local changes',
    regex: /\bgit\b[^\n|;&]*\breset\b[^\n|;&]*\s--hard\b/,
  },
  {
    name: 'git-clean-force',
    description: 'git clean -f deletes untracked files',
    regex: /\bgit\b[^\n|;&]*\bclean\b[^\n|;&]*\s-[a-zA-Z]*f/,
  },
  {
    name: 'git-checkout-dot',
    description: 'checkout -- . discards all working tree changes',
    regex: /\bgit\b[^\n|;&]*\bcheckout\b[^\n|;&]*\s--\s+\./,
  },
  {
    name: 'git-branch-delete-force',
    description: 'branch -D force-deletes a branch',
    regex: /\bgit\b[^\n|;&]*\bbranch\b[^\n|;&]*(\s-[a-zA-Z]*D[a-zA-Z]*\b|\s--delete\s+--force\b)/,
  },
  {
    name: 'git-rebase-interactive',
    description: 'interactive rebase rewrites history',
    regex: /\bgit\b[^\n|;&]*\brebase\b[^\n|;&]*(\s-i\b|\s--interactive\b)/,
  },
  {
    name: 'git-filter-branch',
    description: 'filter-branch rewrites all history',
    regex: /\bgit\b[^\n|;&]*\bfilter-branch\b/,
  },
  {
    name: 'git-update-ref-delete',
    description: 'update-ref -d deletes a ref',
    regex: /\bgit\b[^\n|;&]*\bupdate-ref\b[^\n|;&]*\s-d\b/,
  },
  {
    name: 'sudo',
    description: 'privilege escalation',
    regex: /(^|[\s;&|])sudo\s/,
  },
  {
    name: 'curl-pipe-shell',
    description: 'piping a download straight into a shell',
    regex: /\b(curl|wget)\b[^\n|;&]*\|\s*(\S*\/)?(ba|z|da|fi|k)?sh\b/,
  },
];

/** The first rm invocation in the command, up to a separator. */
const RM_INVOCATION = /(^|[\s;&|])rm\s+([^;|&\n]*)/;

export interface DenyHit {
  name: string;
  description: string;
}

/**
 * Check a shell command against the deny-list. `rm -rf` is only denied when a
 * target resolves OUTSIDE the repo root (SDD §5); inside the repo it falls
 * under the normal shell gate. Unresolvable targets err toward denying.
 */
export function checkDenylist(command: string, opts: { cwd: string; repoRoot: string }): DenyHit | null {
  for (const p of DENY_PATTERNS) {
    if (p.regex.test(command)) return { name: p.name, description: p.description };
  }
  const rm = command.match(RM_INVOCATION);
  if (rm) {
    let recursive = false;
    let force = false;
    const targets: string[] = [];
    for (const token of rm[2]!.trim().split(/\s+/)) {
      if (token === '--recursive') recursive = true;
      else if (token === '--force') force = true;
      else if (token.startsWith('-') && token.length > 1 && !token.startsWith('--')) {
        if (/[rR]/.test(token)) recursive = true;
        if (/f/.test(token)) force = true;
      } else if (token && !token.startsWith('-')) {
        targets.push(token.replace(/^["']|["']$/g, ''));
      }
    }
    if (recursive && force) {
      const outside = targets.some((t) => {
        const resolved = path.resolve(opts.cwd, t.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
        const rel = path.relative(opts.repoRoot, resolved);
        return rel.startsWith('..') || path.isAbsolute(rel) || rel === '';
      });
      if (outside || targets.length === 0) {
        return { name: 'rm-rf-outside-repo', description: 'recursive force delete outside the repo root' };
      }
    }
  }
  return null;
}
