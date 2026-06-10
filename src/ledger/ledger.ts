import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Usage } from '../gateway/client.js';
import type { ModelPricing } from '../config/config.js';

/**
 * Cost ledger (SDD §8): one JSONL record per model call in
 * ~/.arks-code/ledger/YYYY-MM.jsonl. The only telemetry in the product, and
 * it is local-only.
 */

export interface LedgerRecord {
  ts: string;
  session_id: string;
  repo: string;
  branch: string | null;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

/** Cost in USD: cache-miss input + cache-hit input + output, prices per 1M. */
export function computeCost(usage: Usage, pricing: ModelPricing | undefined): number {
  if (!pricing) return 0;
  const cached = Math.min(usage.cached_tokens, usage.prompt_tokens);
  const missed = usage.prompt_tokens - cached;
  const usd =
    (missed * pricing.input + cached * pricing.cacheRead + usage.completion_tokens * pricing.output) /
    1_000_000;
  return Number(usd.toFixed(8));
}

export function monthFileName(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`;
}

export interface LedgerOptions {
  dir: string;
  sessionId: string;
  repo: string;
  branch: string | null;
  pricing: Record<string, ModelPricing>;
  now?: () => Date;
}

export interface SessionTotals {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export class Ledger {
  private totals: SessionTotals = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  };
  private readonly now: () => Date;

  constructor(private opts: LedgerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Append one record for a model call. Never throws — a ledger failure must not kill a session. */
  record(model: string, usage: Usage | null, durationMs: number): LedgerRecord | null {
    if (!usage) return null;
    const cost = computeCost(usage, this.opts.pricing[model]);
    const rec: LedgerRecord = {
      ts: this.now().toISOString(),
      session_id: this.opts.sessionId,
      repo: this.opts.repo,
      branch: this.opts.branch,
      model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      cached_tokens: usage.cached_tokens,
      cost_usd: cost,
      duration_ms: durationMs,
    };
    this.totals.calls++;
    this.totals.promptTokens += usage.prompt_tokens;
    this.totals.completionTokens += usage.completion_tokens;
    this.totals.cachedTokens += usage.cached_tokens;
    this.totals.costUsd += cost;
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true });
      fs.appendFileSync(
        path.join(this.opts.dir, monthFileName(this.now())),
        JSON.stringify(rec) + '\n',
        'utf8',
      );
    } catch {
      // local disk problems must never interrupt the agent
    }
    return rec;
  }

  sessionTotals(): SessionTotals {
    return { ...this.totals };
  }

  /** Month-to-date spend summed from the current month's JSONL. */
  monthToDate(): { costUsd: number; calls: number } {
    const file = path.join(this.opts.dir, monthFileName(this.now()));
    let costUsd = 0;
    let calls = 0;
    try {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as Partial<LedgerRecord>;
          costUsd += rec.cost_usd ?? 0;
          calls++;
        } catch {
          // skip corrupt lines
        }
      }
    } catch {
      // no file yet this month
    }
    return { costUsd, calls };
  }
}
