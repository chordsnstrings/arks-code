import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type * as readline from 'node:readline/promises';
import { approvalTitle } from '../src/repl/approval.js';
import { LineInput } from '../src/repl/input.js';

function fakeRl() {
  const em = new EventEmitter() as EventEmitter & { setPrompt: (p: string) => void; prompt: () => void };
  em.setPrompt = () => {};
  em.prompt = () => {};
  return em;
}

describe('LineInput', () => {
  it('serves lines that arrived before the question (piped stdin)', async () => {
    const rl = fakeRl();
    let echoed = '';
    const input = new LineInput(rl as unknown as readline.Interface, (s) => (echoed += s));
    rl.emit('line', 'y');
    rl.emit('line', 'second');
    await expect(input.question('Apply? ')).resolves.toBe('y');
    await expect(input.question('Next? ')).resolves.toBe('second');
    expect(echoed).toContain('Apply? y');
  });

  it('resolves a pending question when the line arrives later', async () => {
    const rl = fakeRl();
    const input = new LineInput(rl as unknown as readline.Interface, () => {});
    const p = input.question('? ');
    rl.emit('line', 'answer');
    await expect(p).resolves.toBe('answer');
  });

  it('rejects pending and future questions when input closes', async () => {
    const rl = fakeRl();
    const input = new LineInput(rl as unknown as readline.Interface, () => {});
    const p = input.question('? ');
    rl.emit('close');
    await expect(p).rejects.toThrow('input closed');
    await expect(input.question('? ')).rejects.toThrow('input closed');
    expect(input.isClosed()).toBe(true);
  });

  it('still serves buffered lines after close', async () => {
    const rl = fakeRl();
    const input = new LineInput(rl as unknown as readline.Interface, () => {});
    rl.emit('line', 'y');
    rl.emit('close');
    await expect(input.question('? ')).resolves.toBe('y');
  });
});

describe('approvalTitle', () => {
  it('renders EDIT/WRITE titles from summaries', () => {
    expect(
      approvalTitle({
        toolName: 'edit_file',
        actionClass: 'fileWrite',
        summary: 'edit src/auth.ts',
        preview: '',
      }),
    ).toBe('EDIT src/auth.ts');
    expect(
      approvalTitle({
        toolName: 'bash',
        actionClass: 'shell',
        summary: 'bash: npm test',
        preview: 'npm test',
      }),
    ).toBe('RUN npm test');
  });
});
