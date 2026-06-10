import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALL_TOOLS, executeCall, getTool, parseCall, toolDefinitions } from '../src/tools/registry.js';
import { renderTodos, todoTool } from '../src/tools/todo.js';
import type { ToolContext } from '../src/tools/types.js';
import { makeCtx, makeTmpDir } from './helpers.js';

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = makeTmpDir();
  ctx = makeCtx(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('registry', () => {
  it('exposes all seven core tools (GOALS criterion 3)', () => {
    const names = toolDefinitions().map((d) => d.function.name);
    expect(names).toEqual(['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'todo']);
  });

  it('gates exactly the write/shell tools', () => {
    const gates = Object.fromEntries(ALL_TOOLS.map((t) => [t.definition.function.name, t.gate]));
    expect(gates).toEqual({
      read_file: null,
      write_file: 'fileWrite',
      edit_file: 'fileWrite',
      bash: 'shell',
      grep: null,
      glob: null,
      todo: null,
    });
  });

  it('looks up tools by name', () => {
    expect(getTool('bash')).toBeDefined();
    expect(getTool('nope')).toBeUndefined();
  });
});

describe('executeCall never throws (CLAUDE.md rule 6)', () => {
  it('unknown tool → error text', async () => {
    const out = await executeCall('frobnicate', '{}', ctx);
    expect(out).toMatch(/^Error: unknown tool "frobnicate"/);
  });

  it('malformed JSON arguments → error text', async () => {
    const out = await executeCall('read_file', '{"path": ', ctx);
    expect(out).toMatch(/^Error: could not parse tool arguments/);
  });

  it('non-object arguments → error text', async () => {
    const out = await executeCall('read_file', '"just a string"', ctx);
    expect(out).toMatch(/^Error: tool arguments must be a JSON object/);
  });

  it('a handler that throws is converted to error text', async () => {
    const original = getTool('glob')!.execute;
    getTool('glob')!.execute = async () => {
      throw new Error('synthetic explosion');
    };
    try {
      const out = await executeCall('glob', '{"pattern":"*"}', ctx);
      expect(out).toBe('Error: glob failed: synthetic explosion');
    } finally {
      getTool('glob')!.execute = original;
    }
  });

  it('parseCall surfaces valid calls', () => {
    const parsed = parseCall('bash', '{"command":"ls"}');
    expect(typeof parsed).not.toBe('string');
  });
});

describe('todo tool', () => {
  it('replaces the session plan and notifies the renderer', async () => {
    const seen: unknown[] = [];
    ctx.onTodosChanged = (items) => seen.push(items);
    await todoTool.execute(
      { items: [{ text: 'find bug', status: 'completed' }, { text: 'fix bug', status: 'in_progress' }] },
      ctx,
    );
    expect(ctx.todos).toHaveLength(2);
    expect(seen).toHaveLength(1);
    const out = await todoTool.execute({ items: [{ text: 'only one', status: 'pending' }] }, ctx);
    expect(ctx.todos).toHaveLength(1); // replaced, not appended
    expect(out).toContain('[ ] only one');
  });

  it('validates statuses and item shape', async () => {
    expect(await todoTool.execute({ items: [{ text: 'x', status: 'doing' }] }, ctx)).toMatch(/^Error: invalid status/);
    expect(await todoTool.execute({ items: [{ status: 'pending' }] }, ctx)).toMatch(/^Error/);
    expect(await todoTool.execute({ items: 'nope' }, ctx)).toMatch(/^Error/);
  });

  it('renders a checklist', () => {
    const txt = renderTodos([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'pending' },
    ]);
    expect(txt).toBe('[x] a\n[~] b\n[ ] c');
  });
});
