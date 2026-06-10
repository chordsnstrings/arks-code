import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';
import { GatewayError } from '../src/gateway/client.js';
import { Ledger } from '../src/ledger/ledger.js';
import { makePalette } from '../src/repl/colors.js';
import { StreamRenderer, approvalFrame, header, toolLine } from '../src/repl/render.js';
import { HELP_TEXT, handleSlashCommand, renderGatewayError } from '../src/repl/repl.js';
import { Session } from '../src/repl/session.js';
import type { ApprovalAnswer } from '../src/policy/permissions.js';
import { DEFAULT_CONFIG } from '../src/config/config.js';
import { MockGateway, type ScriptStep } from './fixtures/mock-gateway.js';
import { makeTmpDir, write } from './helpers.js';

const plain = makePalette({ noColor: true });
const colored = makePalette({ noColor: false, isTTY: true, colorDepth: 8 });

describe('parseArgs', () => {
  it('parses REPL, one-shot, flags', () => {
    expect(parseArgs([])).toMatchObject({ task: null, yolo: false, model: null });
    expect(parseArgs(['fix the auth bug'])).toMatchObject({ task: 'fix the auth bug' });
    expect(parseArgs(['--yolo', 'task'])).toMatchObject({ yolo: true, task: 'task' });
    expect(parseArgs(['--model', 'code-deep'])).toMatchObject({ model: 'code-deep' });
    expect(parseArgs(['--model=code-deep'])).toMatchObject({ model: 'code-deep' });
    expect(parseArgs(['--version'])).toMatchObject({ version: true });
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['--frobnicate'])).toThrow(/Unknown flag/);
  });
});

describe('palette (NO_COLOR honored)', () => {
  it('NO_COLOR yields identity functions', () => {
    expect(plain.red('x')).toBe('x');
    expect(plain.accent('x')).toBe('x');
  });

  it('256-color terminals get the teal accent, basic terminals plain cyan', () => {
    expect(colored.accent('x')).toContain('38;5;37');
    const basic = makePalette({ noColor: false, isTTY: true, colorDepth: 4 });
    expect(basic.accent('x')).toContain('[36m');
    expect(colored.dim('x')).toContain('[2m');
  });
});

describe('StreamRenderer markdown-lite', () => {
  function render(deltas: string[]): string {
    let outBuf = '';
    const r = new StreamRenderer((s) => (outBuf += s), plain);
    for (const d of deltas) r.push(d);
    r.flush();
    return outBuf;
  }

  it('renders complete lines from fragmented deltas', () => {
    expect(render(['Hel', 'lo\nwor', 'ld'])).toBe('Hello\nworld\n');
  });

  it('marks code fences with a border', () => {
    const out = render(['```ts\nconst x = 1;\n```\nafter\n']);
    expect(out).toContain('┌─ ts');
    expect(out).toContain('│ const x = 1;');
    expect(out).toContain('└─');
    expect(out).toContain('after');
  });

  it('applies bold spans', () => {
    let outBuf = '';
    const r = new StreamRenderer((s) => (outBuf += s), colored);
    r.push('this is **important** stuff\n');
    expect(outBuf).toContain('\x1b[1mimportant\x1b[22m');
  });
});

describe('toolLine / header / approvalFrame', () => {
  it('renders the UX-spec activity line', () => {
    expect(toolLine(plain, 'bash: npm test', { ok: true, ms: 800 })).toBe('⏺ bash: npm test ✓ 0.8s');
    expect(toolLine(plain, 'read src/auth.ts', null)).toBe('⏺ read src/auth.ts …');
    expect(toolLine(plain, 'edit x.ts', { ok: false, ms: 10 })).toContain('✗');
  });

  it('header shows version · model · repo · branch · gateway host', () => {
    const h = header(plain, {
      version: '0.1.0',
      model: 'code-fast',
      repo: 'arks-code',
      branch: 'main',
      gatewayHost: 'gw.arks.internal',
    });
    expect(h).toBe('ARKS Code v0.1.0 · code-fast · arks-code · main · gw.arks.internal');
  });

  it('approval frame includes rules, diff and warnings', () => {
    const frame = approvalFrame(plain, 'EDIT src/auth.ts', '- old line\n+ new line', ['DENY-LIST: danger']);
    expect(frame).toContain('── EDIT src/auth.ts ');
    expect(frame).toContain('- old line');
    expect(frame).toContain('+ new line');
    expect(frame).toContain('⚠ DENY-LIST: danger');
  });
});

describe('renderGatewayError (UX spec errors)', () => {
  it('4xx verbatim with hint', () => {
    const msg = renderGatewayError(new GatewayError('Gateway HTTP 401: bad key', 401, 'bad key'), plain);
    expect(msg).toContain('bad key');
    expect(msg).toContain('/model');
  });

  it('5xx one-liner, conversation intact', () => {
    const msg = renderGatewayError(new GatewayError('Gateway HTTP 503: upstream', 503), plain);
    expect(msg).toContain('conversation intact');
  });
});

describe('Session + slash commands (integration, mock gateway)', () => {
  let dir: string;
  let output: string;

  beforeEach(() => {
    dir = fs.realpathSync(makeTmpDir());
    output = '';
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeSession(
    script: ScriptStep[],
    opts: { yolo?: boolean; answers?: ApprovalAnswer[]; listModels?: () => Promise<string[]> } = {},
  ) {
    const gw = new MockGateway(script);
    const answers = opts.answers ? [...opts.answers] : [];
    const session = new Session({
      cwd: dir,
      config: { ...DEFAULT_CONFIG, baseURL: 'https://gw/v1' },
      yolo: opts.yolo ?? false,
      stream: gw.stream,
      listModels: opts.listModels,
      ledger: new Ledger({
        dir: path.join(dir, '.ledger'),
        sessionId: 's1',
        repo: 'test-repo',
        branch: 'main',
        pricing: DEFAULT_CONFIG.pricing,
      }),
      promptUser: async () => answers.shift() ?? 'no',
      out: (s) => (output += s),
      palette: plain,
    });
    return { session, gw };
  }

  it('streams text, runs approved tools, and records ledger entries', async () => {
    write(dir, 'f.txt', 'content here');
    const { session } = makeSession(
      [
        { content: 'Reading the file.', toolCalls: [{ name: 'read_file', args: { path: 'f.txt' } }] },
        { content: 'Done: it says **content here**.' },
      ],
      { yolo: true },
    );
    const res = await session.runUserTurn('what is in f.txt?');
    expect(res.stopped).toBe('done');
    expect(output).toContain('Reading the file.');
    expect(output).toContain('⏺ read f.txt ✓');
    expect(output).toContain('Done: it says content here.');
    expect(session.messages.filter((m) => m.role === 'tool')).toHaveLength(1);
    // ledger captured both model calls
    expect(session.costReport()).toContain('Session: 2 calls');
  });

  it('denied writes do not touch disk and the model is told', async () => {
    const { session } = makeSession(
      [
        { toolCalls: [{ name: 'write_file', args: { path: 'evil.txt', content: 'x' } }] },
        { content: 'Understood, not writing.' },
      ],
      { answers: ['no'] },
    );
    await session.runUserTurn('write something');
    expect(fs.existsSync(path.join(dir, 'evil.txt'))).toBe(false);
    const toolMsg = session.messages.find((m) => m.role === 'tool') as { content: string };
    expect(toolMsg.content).toContain('User denied');
  });

  it('renders the todo checklist when the model updates the plan', async () => {
    const { session } = makeSession(
      [
        { toolCalls: [{ name: 'todo', args: { items: [{ text: 'step one', status: 'in_progress' }] } }] },
        { content: 'planned.' },
      ],
      { yolo: true },
    );
    await session.runUserTurn('plan it');
    expect(output).toContain('[~] step one');
  });

  it('/help /cost /clear /model /compact /quit dispatch correctly', async () => {
    const { session } = makeSession([{ content: 'hi' }], {
      listModels: async () => ['code-fast', 'code-deep'],
    });
    expect((await handleSlashCommand(session, '/help')).output).toBe(HELP_TEXT);
    expect((await handleSlashCommand(session, '/cost')).output).toContain('Session: 0 calls');
    expect((await handleSlashCommand(session, '/model code-deep')).output).toContain('Switched to code-deep');
    expect(session.model).toBe('code-deep');
    expect((await handleSlashCommand(session, '/model bogus')).output).toContain('not advertised');
    expect(session.model).toBe('code-deep');
    expect((await handleSlashCommand(session, '/compact')).output).toContain('Nothing to compact');
    session.messages.push({ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' });
    await handleSlashCommand(session, '/clear');
    expect(session.messages).toHaveLength(1); // just the system prompt
    expect((await handleSlashCommand(session, '/quit')).quit).toBe(true);
    expect((await handleSlashCommand(session, '/nope')).output).toContain('Unknown command');
    expect((await handleSlashCommand(session, 'not a command')).handled).toBe(false);
  });

  it('/model switches with a warning when /models is unreachable', async () => {
    const { session } = makeSession([{ content: 'hi' }], {
      listModels: async () => {
        throw new Error('offline');
      },
    });
    const res = await handleSlashCommand(session, '/model code-deep');
    expect(res.output).toContain('could not validate');
    expect(session.model).toBe('code-deep');
  });

  it('AGENTS.md from the repo lands in the system prompt (criterion 5 end-to-end)', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    write(dir, 'AGENTS.md', 'ALWAYS USE TABS (test marker)');
    const { session, gw } = makeSession([{ content: 'ok' }]);
    await session.runUserTurn('hello');
    const sys = gw.requests[0]!.messages[0] as { content: string };
    expect(sys.content).toContain('ALWAYS USE TABS (test marker)');
    expect(sys.content).toContain('## Git conventions');
  });
});
