import type { TodoItem } from '../tools/types.js';
import type { Palette } from './colors.js';

/**
 * Markdown-lite streaming renderer (UX spec): bold, code fences with a subtle
 * border, lists pass through. No syntax highlighting in v1. Works on deltas:
 * buffers until a full line is available, then renders the line.
 */
export class StreamRenderer {
  private buffer = '';
  private inFence = false;

  constructor(
    private write: (s: string) => void,
    private palette: Palette,
  ) {}

  push(delta: string): void {
    this.buffer += delta;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.write(this.renderLine(line) + '\n');
    }
  }

  /** Flush any trailing partial line (end of message). */
  flush(): void {
    if (this.buffer) {
      this.write(this.renderLine(this.buffer) + '\n');
      this.buffer = '';
    }
    this.inFence = false;
  }

  private renderLine(line: string): string {
    if (/^\s*```/.test(line)) {
      this.inFence = !this.inFence;
      return this.palette.dim(this.inFence ? '┌─ ' + line.replace(/^\s*```/, '') : '└─');
    }
    if (this.inFence) return this.palette.dim('│ ') + line;
    // **bold** spans
    return line.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => this.palette.bold(inner));
  }
}

/** Single tool-activity line with status glyph, e.g. "⏺ bash: npm test ✓ 0.8s". */
export function toolLine(
  palette: Palette,
  summary: string,
  outcome: { ok: boolean; ms: number } | null,
): string {
  const head = `⏺ ${summary}`;
  if (!outcome) return palette.dim(head + ' …');
  const status = outcome.ok ? '✓' : '✗';
  const time = outcome.ms >= 100 ? ` ${(outcome.ms / 1000).toFixed(1)}s` : '';
  const tail = ` ${status}${time}`;
  return palette.dim(head) + (outcome.ok ? palette.dim(tail) : palette.red(tail));
}

export function todoBlock(palette: Palette, items: TodoItem[]): string {
  const lines = items.map((t) => {
    if (t.status === 'completed') return palette.dim(`  [x] ${t.text}`);
    if (t.status === 'in_progress') return palette.accent(`  [~] ${t.text}`);
    return `  [ ] ${t.text}`;
  });
  return lines.join('\n');
}

export function header(
  palette: Palette,
  info: { version: string; model: string; repo: string; branch: string | null; gatewayHost: string },
): string {
  const parts = [
    palette.accent(palette.bold(`ARKS Code v${info.version}`)),
    info.model,
    info.repo,
    info.branch ?? '(no branch)',
    info.gatewayHost,
  ];
  return parts.join(palette.dim(' · '));
}

const RULE_WIDTH = 49;

/** Approval frame per the UX spec. */
export function approvalFrame(
  palette: Palette,
  title: string,
  preview: string,
  warnings: string[],
): string {
  const head = `── ${title} `.padEnd(RULE_WIDTH, '─');
  const body = preview
    .split('\n')
    .map((l) => {
      if (l.startsWith('+')) return palette.accent(l);
      if (l.startsWith('-')) return palette.yellow(l);
      return l;
    })
    .join('\n');
  const out = [palette.yellow(head)];
  for (const w of warnings) out.push(palette.red(`⚠ ${w}`));
  out.push(body, palette.yellow('─'.repeat(RULE_WIDTH)));
  return out.join('\n');
}
