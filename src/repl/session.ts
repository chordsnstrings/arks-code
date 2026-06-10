import * as path from 'node:path';
import { buildSystemPrompt, compactMessages, currentGitBranch, estimateTokens, findGitRoot } from '../agent/context.js';
import { runTurn, type TurnResult } from '../agent/loop.js';
import type { Config } from '../config/config.js';
import type { ChatMessage, StreamRequest, StreamResult } from '../gateway/client.js';
import type { Ledger } from '../ledger/ledger.js';
import { PermissionEngine, type ApprovalAnswer, type ApprovalRequest } from '../policy/permissions.js';
import { getTool } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { Palette } from './colors.js';
import { StreamRenderer, todoBlock, toolLine } from './render.js';

export interface SessionOptions {
  cwd: string;
  config: Config;
  model?: string;
  yolo: boolean;
  stream: (req: StreamRequest) => Promise<StreamResult>;
  listModels?: () => Promise<string[]>;
  ledger: Ledger;
  promptUser: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
  out: (s: string) => void;
  palette: Palette;
}

/** Wires the agent loop, policy, ledger and renderer into one conversation. */
export class Session {
  model: string;
  readonly ctx: ToolContext;
  readonly messages: ChatMessage[];
  readonly repoRoot: string;
  readonly gitBranch: string | null;
  private readonly engine: PermissionEngine;

  constructor(private opts: SessionOptions) {
    this.model = opts.model ?? opts.config.defaultModel;
    const gitRoot = findGitRoot(opts.cwd);
    this.repoRoot = gitRoot ?? opts.cwd;
    this.gitBranch = currentGitBranch(gitRoot);
    this.ctx = {
      cwd: opts.cwd,
      repoRoot: this.repoRoot,
      todos: [],
      onTodosChanged: (items) => opts.out(todoBlock(opts.palette, items) + '\n'),
    };
    this.messages = [{ role: 'system', content: buildSystemPrompt(opts.cwd) }];
    this.engine = new PermissionEngine({
      yolo: opts.yolo,
      alwaysAllow: opts.config.alwaysAllow,
      promptUser: opts.promptUser,
    });
  }

  async runUserTurn(input: string, signal?: AbortSignal): Promise<TurnResult> {
    const { out, palette } = this.opts;
    this.messages.push({ role: 'user', content: input });
    const renderer = new StreamRenderer(out, palette);
    try {
      const result = await runTurn(
        {
          stream: this.opts.stream,
          model: () => this.model,
          ctx: this.ctx,
          gate: (req) => this.engine.gate(req, this.ctx),
          compactThreshold: this.opts.config.compactThreshold,
          estimateTokens,
          compact: async (messages) => {
            const res = await compactMessages(messages, { stream: this.opts.stream, model: this.model });
            if (res.compacted) out(palette.dim('⏺ context compacted\n'));
            return res;
          },
          onTextDelta: (t) => renderer.push(t),
          onToolStart: () => {
            renderer.flush();
          },
          onToolEnd: (call, result, ms) => {
            const parsed = this.describeCall(call.function.name, call.function.arguments);
            const ok = !result.startsWith('Error');
            out(toolLine(palette, parsed, { ok, ms }) + '\n');
          },
          onUsage: (model, usage, durationMs) => {
            this.opts.ledger.record(model, usage, durationMs);
          },
          signal,
        },
        this.messages,
      );
      renderer.flush();
      if (result.stopped === 'max-iterations') {
        out(
          palette.red('⏺ stopped: reached the 50-iteration limit for one turn. ') +
            'Ask me to continue if you want me to keep going.\n',
        );
      }
      return result;
    } finally {
      renderer.flush();
    }
  }

  private describeCall(name: string, argsJson: string): string {
    try {
      const args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
      return getTool(name)?.summarize(args, this.ctx) ?? name;
    } catch {
      return name;
    }
  }

  /** /compact — force compaction now. */
  async compactNow(): Promise<string> {
    const before = estimateTokens(this.messages);
    const res = await compactMessages(this.messages, { stream: this.opts.stream, model: this.model });
    if (!res.compacted) return 'Nothing to compact yet (conversation too short).';
    return `Compacted: ~${before} → ~${estimateTokens(this.messages)} tokens.`;
  }

  /** /clear — new conversation, same session (ledger keeps accumulating). */
  clear(): void {
    this.messages.splice(1);
    this.ctx.todos = [];
  }

  /** /cost — session + month-to-date from the ledger. */
  costReport(): string {
    const t = this.opts.ledger.sessionTotals();
    const mtd = this.opts.ledger.monthToDate();
    const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return [
      `Session: ${t.calls} calls · ${fmt(t.promptTokens)} in (${fmt(t.cachedTokens)} cached) · ${fmt(
        t.completionTokens,
      )} out · $${t.costUsd.toFixed(4)}`,
      `Month to date: $${mtd.costUsd.toFixed(4)} across ${mtd.calls} calls`,
    ].join('\n');
  }

  /** /model — switch model, validating against the gateway when possible. */
  async switchModel(alias: string): Promise<string> {
    if (!alias) return `Current model: ${this.model}`;
    if (this.opts.listModels) {
      try {
        const models = await this.opts.listModels();
        if (models.length > 0 && !models.includes(alias)) {
          return `Model "${alias}" is not advertised by the gateway (${models.join(', ')}). Model unchanged.`;
        }
      } catch {
        // gateway /models unavailable — switch anyway, but say so
        this.model = alias;
        return `Switched to ${alias} (could not validate against gateway /models).`;
      }
    }
    this.model = alias;
    return `Switched to ${alias}.`;
  }
}

export function repoName(repoRoot: string): string {
  return path.basename(repoRoot);
}
