#!/usr/bin/env node
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  apiKey,
  configDir,
  configFileExists,
  loadConfig,
  saveConfig,
  DEFAULT_CONFIG,
  type Config,
} from './config/config.js';
import { currentGitBranch, findGitRoot } from './agent/context.js';
import { GatewayClient } from './gateway/client.js';
import { Ledger } from './ledger/ledger.js';
import { makeApprovalPrompter } from './repl/approval.js';
import { makePalette } from './repl/colors.js';
import { LineInput } from './repl/input.js';
import { header } from './repl/render.js';
import { renderGatewayError, runRepl } from './repl/repl.js';
import { Session, repoName } from './repl/session.js';

export interface CliArgs {
  task: string | null;
  yolo: boolean;
  model: string | null;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { task: null, yolo: false, model: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--yolo') args.yolo = true;
    else if (a === '--model') args.model = argv[++i] ?? null;
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (!a.startsWith('-') && args.task === null) args.task = a;
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

export const USAGE = `Usage:
  arks                      start a REPL in the current directory
  arks "task description"   one-shot: run the task, print the result, exit
  arks --yolo               skip approval gates (deny-list still active)
  arks --model <alias>      override the default model
  arks --version | --help

Environment:
  ARKS_LLM_KEY        gateway API key (required)
  ARKS_LLM_BASE_URL   override gateway base URL
  ARKS_LLM_MODEL      override default model`;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** First run with no config → interactive init (SDD §9). */
async function firstRunInit(input: LineInput): Promise<Config> {
  process.stdout.write('No config found — first-run setup.\n');
  let baseURL = '';
  while (!baseURL) {
    baseURL = (await input.question('ARKS AI Gateway base URL (e.g. https://gateway.arks.internal/v1): ')).trim();
  }
  const cfg: Config = { ...DEFAULT_CONFIG, baseURL };
  saveConfig(cfg);
  process.stdout.write(`Saved ${path.join(configDir(), 'config.json')}\n`);
  return cfg;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const palette = makePalette();
  const out = (s: string) => process.stdout.write(s);

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    out(USAGE + '\n');
    return 0;
  }
  if (args.version) {
    out(`arks-code v${packageVersion()}\n`);
    return 0;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const input = new LineInput(rl, out);
  try {
    let config = loadConfig();
    if (!config.baseURL) {
      if (!configFileExists() && process.stdin.isTTY) {
        config = await firstRunInit(input);
      } else {
        process.stderr.write(
          'No gateway base URL configured. Set ARKS_LLM_BASE_URL or add "baseURL" to ~/.arks-code/config.json.\n',
        );
        return 1;
      }
    }
    const key = apiKey();
    if (!key) {
      process.stderr.write('ARKS_LLM_KEY is not set. Export your gateway key and retry.\n');
      return 1;
    }

    const gateway = new GatewayClient({ baseURL: config.baseURL, apiKey: key });
    const cwd = process.cwd();
    const gitRoot = findGitRoot(cwd);
    const session = new Session({
      cwd,
      config,
      model: args.model ?? undefined,
      yolo: args.yolo,
      stream: (req) => gateway.stream(req),
      listModels: () => gateway.listModels(),
      ledger: new Ledger({
        dir: path.join(configDir(), 'ledger'),
        sessionId: randomUUID(),
        repo: repoName(gitRoot ?? cwd),
        branch: currentGitBranch(gitRoot),
        pricing: config.pricing,
      }),
      promptUser: makeApprovalPrompter(input, out, palette),
      out,
      palette,
    });

    let gatewayHost: string;
    try {
      gatewayHost = new URL(config.baseURL).host;
    } catch {
      gatewayHost = config.baseURL;
    }

    if (args.task !== null) {
      // one-shot mode: run the task, print the result, exit 0 on success
      try {
        const result = await session.runUserTurn(args.task);
        return result.stopped === 'done' ? 0 : 1;
      } catch (err) {
        process.stderr.write(renderGatewayError(err, palette) + '\n');
        return 1;
      }
    }

    out(
      header(palette, {
        version: packageVersion(),
        model: session.model,
        repo: repoName(session.repoRoot),
        branch: session.gitBranch,
        gatewayHost,
      }) + '\n',
    );
    if (args.yolo) out(palette.yellow('--yolo: approval gates off (deny-list still active)\n'));
    out(palette.dim('Type a task, or /help for commands.\n'));
    await runRepl({ session, rl, input, out, palette });
    return 0;
  } finally {
    rl.close();
  }
}

const isDirectRun = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
