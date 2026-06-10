import type * as readline from 'node:readline/promises';
import { GatewayError } from '../gateway/client.js';
import type { Palette } from './colors.js';
import type { LineInput } from './input.js';
import type { Session } from './session.js';

export const HELP_TEXT = `Commands:
  /model <alias>   switch model (validated against gateway /models)
  /cost            session + month-to-date spend from the ledger
  /compact         force context compaction now
  /clear           new conversation, same session
  /help            this list
  /quit            exit (Ctrl+C twice also exits)`;

export interface SlashResult {
  handled: boolean;
  quit?: boolean;
  output?: string;
}

/** Dispatch a /command line; returns handled=false for normal input. */
export async function handleSlashCommand(session: Session, line: string): Promise<SlashResult> {
  if (!line.startsWith('/')) return { handled: false };
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
  switch ((cmd ?? '').toLowerCase()) {
    case 'help':
      return { handled: true, output: HELP_TEXT };
    case 'quit':
    case 'exit':
      return { handled: true, quit: true };
    case 'cost':
      return { handled: true, output: session.costReport() };
    case 'clear':
      session.clear();
      return { handled: true, output: '(conversation cleared)' };
    case 'compact':
      return { handled: true, output: await session.compactNow() };
    case 'model':
      return { handled: true, output: await session.switchModel(rest.join(' ')) };
    default:
      return { handled: true, output: `Unknown command: /${cmd}. Try /help.` };
  }
}

export function renderGatewayError(err: unknown, palette: Palette): string {
  if (err instanceof GatewayError) {
    if (err.status !== undefined && err.status >= 400 && err.status < 500) {
      // 4xx verbatim, with a hint (UX spec)
      return (
        palette.red(`Gateway error ${err.status}: ${err.body ?? err.message}`) +
        '\n' +
        palette.dim('Check your model alias (/model) and ARKS_LLM_KEY.')
      );
    }
    return palette.red(`Gateway error after retries: ${err.message}`) + palette.dim(' — conversation intact, retry when ready.');
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return palette.dim('(cancelled)');
  }
  return palette.red(`Error: ${err instanceof Error ? err.message : String(err)}`);
}

export interface ReplOptions {
  session: Session;
  rl: readline.Interface;
  input: LineInput;
  out: (s: string) => void;
  palette: Palette;
}

/** Interactive REPL loop. Ctrl+C once cancels the current call, twice exits. */
export async function runRepl(opts: ReplOptions): Promise<void> {
  const { session, rl, input, out, palette } = opts;
  let turnAbort: AbortController | null = null;
  let lastSigint = 0;

  rl.on('SIGINT', () => {
    const now = Date.now();
    if (turnAbort) {
      turnAbort.abort(new Error('cancelled by Ctrl+C'));
      turnAbort = null;
      out('\n' + palette.dim('(model call cancelled — Ctrl+C again to exit)') + '\n');
      lastSigint = now;
      return;
    }
    if (now - lastSigint < 2000) {
      rl.close();
      process.exit(0);
    }
    lastSigint = now;
    out('\n' + palette.dim('(Ctrl+C again to exit)') + '\n');
    rl.prompt();
  });

  for (;;) {
    let line: string;
    try {
      line = (await input.question(palette.accent('❯ '))).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;

    const slash = await handleSlashCommand(session, line).catch((err: unknown) => ({
      handled: true,
      output: renderGatewayError(err, palette),
    }));
    if (slash.handled) {
      if (slash.output) out(slash.output + '\n');
      if ('quit' in slash && slash.quit) break;
      continue;
    }

    turnAbort = new AbortController();
    try {
      await session.runUserTurn(line, turnAbort.signal);
    } catch (err) {
      out(renderGatewayError(err, palette) + '\n');
    } finally {
      turnAbort = null;
    }
  }
}
