import type { GateDecision, GateRequest } from '../agent/loop.js';
import { isOutsideRepoRoot, resolveToolPath } from '../tools/paths.js';
import type { ToolContext } from '../tools/types.js';
import { checkDenylist, type DenyHit } from './denylist.js';

/**
 * Permission model (SDD §5). States per action class {fileWrite, shell}:
 * ask (default) | session-allow | always-allow (persisted) | yolo (CLI flag).
 * Deny-list hits and absolute paths outside the repo root ALWAYS prompt,
 * even under yolo/always-allow.
 */

export type ActionClass = 'fileWrite' | 'shell';

export interface ApprovalRequest {
  toolName: string;
  /** What class of action this is. */
  actionClass: ActionClass;
  /** One-line summary for the prompt header. */
  summary: string;
  /** Full diff (edit/write) or exact command (bash). */
  preview: string;
  /** Set when this prompt is forced by the deny-list. */
  denyHit?: DenyHit;
  /** Set when the path escapes the repo root. */
  outsideRepoRoot?: string;
}

export type ApprovalAnswer = 'yes' | 'no' | 'always-session';

export interface PermissionEngineOptions {
  yolo: boolean;
  alwaysAllow: { fileWrite: boolean; shell: boolean };
  /** Blocking user prompt; wired to the REPL approval UI. */
  promptUser: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
}

export class PermissionEngine {
  private sessionAllow: Record<ActionClass, boolean> = { fileWrite: false, shell: false };

  constructor(private opts: PermissionEngineOptions) {}

  /** The gate plugged into the agent loop. */
  gate = async (req: GateRequest, ctx: ToolContext): Promise<GateDecision> => {
    const tool = req.tool;
    if (!tool) return { allowed: true }; // unknown tool → registry returns error text
    const actionClass = tool.gate;
    if (actionClass === null) return { allowed: true };

    const name = tool.definition.function.name;
    const preview = tool.preview?.(req.args, ctx) ?? JSON.stringify(req.args, null, 2);
    const summary = tool.summarize(req.args, ctx);

    let denyHit: DenyHit | undefined;
    if (actionClass === 'shell') {
      denyHit = checkDenylist(String(req.args.command ?? ''), {
        cwd: ctx.cwd,
        repoRoot: ctx.repoRoot,
      }) ?? undefined;
    }

    let outsideRepoRoot: string | undefined;
    if (actionClass === 'fileWrite' && typeof req.args.path === 'string') {
      const resolved = resolveToolPath(ctx, req.args.path);
      if (isOutsideRepoRoot(ctx, resolved)) outsideRepoRoot = resolved;
    }

    const forcedPrompt = denyHit !== undefined || outsideRepoRoot !== undefined;
    if (!forcedPrompt) {
      if (this.opts.yolo) return { allowed: true };
      if (this.opts.alwaysAllow[actionClass]) return { allowed: true };
      if (this.sessionAllow[actionClass]) return { allowed: true };
    }

    const answer = await this.opts.promptUser({
      toolName: name,
      actionClass,
      summary,
      preview,
      denyHit,
      outsideRepoRoot,
    });
    if (answer === 'always-session') {
      // "always" never extends to deny-listed actions or repo escapes
      if (!forcedPrompt) this.sessionAllow[actionClass] = true;
      return { allowed: true };
    }
    if (answer === 'yes') return { allowed: true };
    return { allowed: false };
  };
}
