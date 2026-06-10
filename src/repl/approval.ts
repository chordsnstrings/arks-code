import type * as readline from 'node:readline/promises';
import type { ApprovalAnswer, ApprovalRequest } from '../policy/permissions.js';
import type { Palette } from './colors.js';
import { approvalFrame } from './render.js';

const PREVIEW_LINES = 24;

/**
 * Blocking approval prompt (UX spec): renders the full diff or exact command,
 * then asks y / n / a (always this session) / d (show more context).
 */
export function makeApprovalPrompter(
  rl: readline.Interface,
  out: (s: string) => void,
  palette: Palette,
): (req: ApprovalRequest) => Promise<ApprovalAnswer> {
  return async (req: ApprovalRequest): Promise<ApprovalAnswer> => {
    const title = `${req.actionClass === 'shell' ? 'RUN' : req.toolName.replace('_file', '').toUpperCase()} ${req.summary}`;
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
      const answer = (await rl.question(q)).trim().toLowerCase();
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
