import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import type { RegisteredTool, ToolContext } from './types.js';

export const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;
const CWD_SENTINEL = '__ARKS_CWD__';

export interface ShellInfo {
  shell: string;
  args: string[];
  kind: 'posix' | 'powershell' | 'cmd';
}

/** Platform default shell: $SHELL if set, else powershell.exe on Windows, /bin/bash elsewhere. */
export function platformShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ShellInfo {
  const fromEnv = env.SHELL;
  if (platform === 'win32') {
    if (fromEnv) {
      const lower = fromEnv.toLowerCase();
      if (lower.includes('powershell') || lower.includes('pwsh')) {
        return { shell: fromEnv, args: ['-NoProfile', '-Command'], kind: 'powershell' };
      }
      if (lower.includes('cmd')) return { shell: fromEnv, args: ['/d', '/s', '/c'], kind: 'cmd' };
      return { shell: fromEnv, args: ['-c'], kind: 'posix' };
    }
    return { shell: 'powershell.exe', args: ['-NoProfile', '-Command'], kind: 'powershell' };
  }
  return { shell: fromEnv ?? '/bin/bash', args: ['-c'], kind: 'posix' };
}

/** Wrap the command so the final working directory is reported on a sentinel line. */
function wrapCommand(command: string, kind: ShellInfo['kind']): string {
  if (kind === 'posix') {
    return `${command}\n__arks_ec=$?\nprintf '\\n${CWD_SENTINEL}%s\\n' "$PWD"\nexit $__arks_ec`;
  }
  if (kind === 'powershell') {
    return `${command}\nWrite-Output "\`n${CWD_SENTINEL}$((Get-Location).Path)"`;
  }
  return `${command}\r\necho.\r\necho ${CWD_SENTINEL}%CD%`;
}

/** Head+tail truncation for outputs over the cap (SDD §3). */
export function truncateOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 100) / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n… [${omitted} characters truncated] …\n\n${text.slice(-half)}`;
}

export interface BashResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  cwd: string;
}

export function runShellCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; shellInfo?: ShellInfo },
): Promise<BashResult> {
  const info = opts.shellInfo ?? platformShell(opts.env);
  const wrapped = wrapCommand(command, info.kind);
  return new Promise((resolve) => {
    const child = spawn(info.shell, [...info.args, wrapped], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const chunks: string[] = [];
    let timedOut = false;
    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    // stdout+stderr interleaved in arrival order
    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      let output = chunks.join('');
      let cwd = opts.cwd;
      const idx = output.lastIndexOf(CWD_SENTINEL);
      if (idx !== -1) {
        const after = output.slice(idx + CWD_SENTINEL.length);
        const reported = (after.split('\n')[0] ?? '').trim();
        output = (output.slice(0, idx) + after.split('\n').slice(1).join('\n')).replace(/\n$/, '');
        if (reported && fs.existsSync(reported)) cwd = reported;
      }
      resolve({ output, exitCode, timedOut, cwd });
    };
    child.on('error', (err) => {
      chunks.push(`Failed to start shell (${info.shell}): ${err.message}`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

export const bashTool: RegisteredTool = {
  gate: 'shell',
  definition: {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a command in the platform default shell. The working directory persists across ' +
        'calls within the session (cd sticks). stdout and stderr are interleaved; output over ' +
        '30k characters is head+tail truncated.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run.' },
          timeout: {
            type: 'integer',
            description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}).`,
          },
        },
        required: ['command'],
      },
    },
  },
  summarize(args) {
    const cmd = String(args.command ?? '').replace(/\s+/g, ' ');
    return `bash: ${cmd.length > 80 ? cmd.slice(0, 77) + '…' : cmd}`;
  },
  preview(args) {
    return String(args.command ?? '');
  },
  async execute(args, ctx: ToolContext) {
    const command = String(args.command ?? '');
    if (!command.trim()) return 'Error: empty command.';
    const timeoutS = Math.min(Math.max(Number(args.timeout ?? DEFAULT_TIMEOUT_S), 1), MAX_TIMEOUT_S);
    const res = await runShellCommand(command, { cwd: ctx.cwd, timeoutMs: timeoutS * 1000 });
    ctx.cwd = res.cwd;
    let out = truncateOutput(res.output);
    if (res.timedOut) out += `\n[command timed out after ${timeoutS}s and was killed]`;
    else if (res.exitCode !== 0 && res.exitCode !== null) out += `\n[exit code ${res.exitCode}]`;
    return out.trim() === '' ? '(no output)' : out;
  },
};
