import type * as readline from 'node:readline/promises';

/**
 * Line input with buffering. Unlike rl.question, lines that arrive while no
 * prompt is pending (e.g. piped stdin in one-shot mode, or a user typing
 * ahead) are queued and served to the next question instead of being dropped.
 */
export class LineInput {
  private buffered: string[] = [];
  private waiter: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(
    private rl: readline.Interface,
    private out: (s: string) => void,
  ) {
    rl.on('line', (line: string) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(line);
      } else {
        this.buffered.push(line);
      }
    });
    rl.on('close', () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w.reject(new Error('input closed'));
      }
    });
  }

  /** True when stdin has ended; questions will fail immediately. */
  isClosed(): boolean {
    return this.closed && this.buffered.length === 0;
  }

  async question(prompt: string): Promise<string> {
    if (this.buffered.length > 0) {
      const line = this.buffered.shift()!;
      this.out(prompt + line + '\n'); // echo what was consumed, for the transcript
      return line;
    }
    if (this.closed) throw new Error('input closed');
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise<string>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}
