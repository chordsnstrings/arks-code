import type { RegisteredTool, TodoItem, TodoStatus } from './types.js';

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];

export function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return '(todo list is empty)';
  return items
    .map((t) => {
      const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      return `${box} ${t.text}`;
    })
    .join('\n');
}

export const todoTool: RegisteredTool = {
  gate: null,
  definition: {
    type: 'function',
    function: {
      name: 'todo',
      description:
        'Replace the session task list with the given items. Use it to plan multi-step work ' +
        'and keep statuses current (pending | in_progress | completed) as you go.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'The full task list; replaces any previous list.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: STATUSES },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  summarize(args) {
    const items = Array.isArray(args.items) ? args.items : [];
    return `todo (${items.length} items)`;
  },
  async execute(args, ctx) {
    if (!Array.isArray(args.items)) return 'Error: items must be an array of {text, status}.';
    const items: TodoItem[] = [];
    for (const raw of args.items as unknown[]) {
      const it = raw as { text?: unknown; status?: unknown };
      if (typeof it?.text !== 'string' || !it.text.trim()) {
        return 'Error: every item needs a non-empty text string.';
      }
      const status = (it.status ?? 'pending') as TodoStatus;
      if (!STATUSES.includes(status)) {
        return `Error: invalid status "${String(it.status)}"; use one of ${STATUSES.join(', ')}.`;
      }
      items.push({ text: it.text, status });
    }
    ctx.todos = items;
    ctx.onTodosChanged?.(items);
    return `Todo list updated:\n${renderTodos(items)}`;
  },
};
