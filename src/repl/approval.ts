import type { ApprovalAnswer, ApprovalRequest } from '../policy/permissions.js';
import type { Palette } from './colors.js';
import type { LineInput } from './input.js';
import { approvalFrame } from './render.js';

const PREVIEW_LINES = 24;

/** "edit src/auth.ts" → "EDIT src/auth.ts"; "bash: npm test" → "RUN npm test". */
export function approvalTitle(req: ApprovalRequest): string {
  if (req.actionClass === 'shell') return `RUN ${req.summary.replace(/^bash:\s*/, '')}`;
  return req.summary.replace(/^\S+/, (w) => w.toUpperCase());
}

/**
 * Blocking approval prompt (UX spec): renders the full diff or exact command,
 * then asks y / n / a (always this session) / d (show more context).
 */
export function makeApprovalPrompter(
  input: LineInput,
  out: (s: string) => void,
  palette: Palette,
): (req: ApprovalRequest) => Promise<ApprovalAnswer> {
  return async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
    const title = approvalTitle(req);
    const warnings: string[] = [];
    if (req.denyHit) {
      warnings.push(`DENY-LIST: ${req.denyHit.description} — explicit approval required`);
    }
    if (req.outsideRepoRoot) {
      warnings.push(`path is OUTSIDE the repo root: ${req.outsideRepoRoot}`);
    }
    let showFull = false;
    for (;;) {
      const lines = req.preview.split('\n');
      const preview =
        !showFull && lines.length > PREVIEW_LINES
          ? [...lines.slice(0, PREVIEW_LINES), `… (${lines.length - PREVIEW_LINES} more lines — press d)`].join('\n')
          : req.preview;
      out(approvalFrame(palette, title, preview, warnings) + '\n');
      const q = palette.yellow('Apply? [y]es [n]o [a]lways this session [d]iff context → ');
      const answer = (await input.question(q)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') return 'yes';
      if (answer === 'a' || answer === 'always') return 'always-session';
      if (answer === 'd') {
        showFull = true;
        continue;
      }
      return 'no'; // anything else, including empty, is a safe no
    }
  };
}
