/**
 * Tone & color (UX spec): dim for tool lines, default for assistant text,
 * yellow for approval prompts, red only for errors. Honor NO_COLOR. Cyan
 * #0E9AAB-adjacent accent where 256-color is available; graceful fallback.
 */

export interface Palette {
  dim(s: string): string;
  bold(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  accent(s: string): string;
}

const PLAIN: Palette = {
  dim: (s) => s,
  bold: (s) => s,
  yellow: (s) => s,
  red: (s) => s,
  accent: (s) => s,
};

export interface PaletteOptions {
  noColor?: boolean;
  isTTY?: boolean;
  colorDepth?: number;
}

export function makePalette(opts: PaletteOptions = {}): Palette {
  const noColor = opts.noColor ?? process.env.NO_COLOR !== undefined;
  const isTTY = opts.isTTY ?? process.stdout.isTTY ?? false;
  if (noColor || !isTTY) return PLAIN;
  const depth =
    opts.colorDepth ??
    (typeof process.stdout.getColorDepth === 'function' ? process.stdout.getColorDepth() : 4);
  const wrap = (open: string, close: string) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
  return {
    dim: wrap('2', '22'),
    bold: wrap('1', '22'),
    yellow: wrap('33', '39'),
    red: wrap('31', '39'),
    // xterm-256 color 37 (#00afaf) is the closest to #0E9AAB
    accent: depth >= 8 ? wrap('38;5;37', '39') : wrap('36', '39'),
  };
}
