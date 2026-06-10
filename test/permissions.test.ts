import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateRequest } from '../src/agent/loop.js';
import { PermissionEngine, type ApprovalAnswer, type ApprovalRequest } from '../src/policy/permissions.js';
import { getTool } from '../src/tools/registry.js';
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

function gateReq(toolName: string, args: Record<string, unknown>): GateRequest {
  return {
    call: {
      id: 'c1',
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(args) },
    },
    tool: getTool(toolName),
    args,
  };
}

function engine(
  answers: ApprovalAnswer[] | ApprovalAnswer = 'no',
  opts: { yolo?: boolean; alwaysAllow?: { fileWrite: boolean; shell: boolean } } = {},
) {
  const queue = Array.isArray(answers) ? [...answers] : [];
  const single = Array.isArray(answers) ? null : answers;
  const prompts: ApprovalRequest[] = [];
  const promptUser = vi.fn(async (req: ApprovalRequest) => {
    prompts.push(req);
    return single ?? queue.shift() ?? 'no';
  });
  const eng = new PermissionEngine({
    yolo: opts.yolo ?? false,
    alwaysAllow: opts.alwaysAllow ?? { fileWrite: false, shell: false },
    promptUser,
  });
  return { eng, promptUser, prompts };
}

describe('permission gates (GOALS criterion 4)', () => {
  it('ungated tools never prompt', async () => {
    const { eng, promptUser } = engine('no');
    const d = await eng.gate(gateReq('read_file', { path: 'x.txt' }), ctx);
    expect(d.allowed).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('file writes prompt by default; "no" denies', async () => {
    const { eng, prompts } = engine('no');
    const d = await eng.gate(gateReq('write_file', { path: 'x.txt', content: 'hi' }), ctx);
    expect(d.allowed).toBe(false);
    expect(prompts[0]!.actionClass).toBe('fileWrite');
    expect(prompts[0]!.preview).toContain('+ hi'); // full diff rendered before asking
  });

  it('shell commands prompt by default with the exact command as preview', async () => {
    const { eng, prompts } = engine('yes');
    const d = await eng.gate(gateReq('bash', { command: 'npm test' }), ctx);
    expect(d.allowed).toBe(true);
    expect(prompts[0]!.preview).toBe('npm test');
  });

  it('"always this session" stops further prompts for that class only', async () => {
    const { eng, promptUser } = engine(['always-session']);
    await eng.gate(gateReq('bash', { command: 'ls' }), ctx);
    const d2 = await eng.gate(gateReq('bash', { command: 'pwd' }), ctx);
    expect(d2.allowed).toBe(true);
    expect(promptUser).toHaveBeenCalledTimes(1);
    // a different class still prompts
    await eng.gate(gateReq('write_file', { path: 'f', content: 'x' }), ctx);
    expect(promptUser).toHaveBeenCalledTimes(2);
  });

  it('--yolo bypasses normal gates', async () => {
    const { eng, promptUser } = engine('no', { yolo: true });
    const d1 = await eng.gate(gateReq('bash', { command: 'npm test' }), ctx);
    const d2 = await eng.gate(gateReq('write_file', { path: 'f', content: 'x' }), ctx);
    expect(d1.allowed).toBe(true);
    expect(d2.allowed).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });

  it('persisted always-allow bypasses prompts per class', async () => {
    const { eng, promptUser } = engine('no', { alwaysAllow: { fileWrite: true, shell: false } });
    expect((await eng.gate(gateReq('write_file', { path: 'f', content: 'x' }), ctx)).allowed).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
    expect((await eng.gate(gateReq('bash', { command: 'ls' }), ctx)).allowed).toBe(false);
    expect(promptUser).toHaveBeenCalledTimes(1);
  });
});

describe('deny-list interaction (ALWAYS prompts, even yolo)', () => {
  it('deny-listed git commands prompt under yolo', async () => {
    const { eng, prompts } = engine('no', { yolo: true });
    const d = await eng.gate(gateReq('bash', { command: 'git push --force' }), ctx);
    expect(d.allowed).toBe(false);
    expect(prompts[0]!.denyHit?.name).toBe('git-push-force');
  });

  it('deny-listed commands prompt under always-allow and session-allow', async () => {
    const { eng, promptUser } = engine(['always-session', 'yes'], {
      alwaysAllow: { fileWrite: false, shell: true },
    });
    // session-allow granted on a benign command — wait, alwaysAllow.shell covers it:
    const benign = await eng.gate(gateReq('bash', { command: 'ls' }), ctx);
    expect(benign.allowed).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
    const d = await eng.gate(gateReq('bash', { command: 'git reset --hard' }), ctx);
    expect(promptUser).toHaveBeenCalledTimes(1);
    expect(d.allowed).toBe(true); // explicit y was given
  });

  it('"always" answered on a deny-list prompt does NOT whitelist the class', async () => {
    const { eng, promptUser } = engine(['always-session', 'no']);
    const d1 = await eng.gate(gateReq('bash', { command: 'git push -f' }), ctx);
    expect(d1.allowed).toBe(true); // approved this once
    const d2 = await eng.gate(gateReq('bash', { command: 'rm -rf src' }), ctx);
    expect(promptUser).toHaveBeenCalledTimes(2); // still prompted
    expect(d2.allowed).toBe(false);
  });
});

describe('paths outside the repo root (SDD §3: gated even in yolo)', () => {
  it('absolute write outside the repo prompts under yolo', async () => {
    const { eng, prompts } = engine('no', { yolo: true });
    const outside = `${dir}-other/escape.txt`;
    const d = await eng.gate(gateReq('write_file', { path: outside, content: 'x' }), ctx);
    expect(d.allowed).toBe(false);
    expect(prompts[0]!.outsideRepoRoot).toContain('escape.txt');
  });

  it('relative ../ escapes are caught too', async () => {
    const { eng, prompts } = engine('yes', { yolo: true });
    const d = await eng.gate(gateReq('edit_file', { path: '../up.txt', old_str: 'a', new_str: 'b' }), ctx);
    expect(prompts).toHaveLength(1);
    expect(d.allowed).toBe(true); // explicit y
  });

  it('writes inside the repo do not trip the outside-root check', async () => {
    const { eng, promptUser } = engine('no', { yolo: true });
    const d = await eng.gate(gateReq('write_file', { path: 'sub/inside.txt', content: 'x' }), ctx);
    expect(d.allowed).toBe(true);
    expect(promptUser).not.toHaveBeenCalled();
  });
});
