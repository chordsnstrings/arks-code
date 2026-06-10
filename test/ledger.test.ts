import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, computeCost, monthFileName, type LedgerRecord } from '../src/ledger/ledger.js';
import { makeTmpDir } from './helpers.js';

const pricing = {
  'code-fast': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
};

let dir: string;

beforeEach(() => {
  dir = makeTmpDir('arks-ledger-');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeLedger(now = () => new Date('2026-06-10T12:00:00Z')) {
  return new Ledger({
    dir,
    sessionId: 'sess-1',
    repo: 'arks-code',
    branch: 'main',
    pricing,
    now,
  });
}

describe('computeCost (ledger math)', () => {
  it('splits prompt tokens into cache hits and misses', () => {
    // 1M cache-miss in = $0.14; here: 600k miss + 400k hit + 100k out
    const cost = computeCost(
      { prompt_tokens: 1_000_000, completion_tokens: 100_000, cached_tokens: 400_000 },
      pricing['code-fast'],
    );
    // 0.6*0.14 + 0.4*0.0028 + 0.1*0.28 = 0.084 + 0.00112 + 0.028
    expect(cost).toBeCloseTo(0.11312, 6);
  });

  it('clamps cached_tokens to prompt_tokens', () => {
    const cost = computeCost(
      { prompt_tokens: 100, completion_tokens: 0, cached_tokens: 500 },
      pricing['code-fast'],
    );
    expect(cost).toBeCloseTo((100 * 0.0028) / 1e6, 12);
  });

  it('unknown model pricing → cost 0, never NaN', () => {
    expect(computeCost({ prompt_tokens: 10, completion_tokens: 10, cached_tokens: 0 }, undefined)).toBe(0);
  });
});

describe('Ledger', () => {
  it('writes one JSONL record per call with the SDD §8 shape', () => {
    const ledger = makeLedger();
    ledger.record('code-fast', { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 100 }, 1234);
    const file = path.join(dir, '2026-06.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as LedgerRecord;
    expect(rec).toMatchObject({
      ts: '2026-06-10T12:00:00.000Z',
      session_id: 'sess-1',
      repo: 'arks-code',
      branch: 'main',
      model: 'code-fast',
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 100,
      duration_ms: 1234,
    });
    expect(rec.cost_usd).toBeGreaterThan(0);
  });

  it('accumulates session totals across calls', () => {
    const ledger = makeLedger();
    ledger.record('code-fast', { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 0 }, 10);
    ledger.record('code-fast', { prompt_tokens: 2000, completion_tokens: 300, cached_tokens: 500 }, 20);
    const t = ledger.sessionTotals();
    expect(t.calls).toBe(2);
    expect(t.promptTokens).toBe(3000);
    expect(t.completionTokens).toBe(400);
    expect(t.cachedTokens).toBe(500);
    expect(t.costUsd).toBeGreaterThan(0);
  });

  it('skips records with no usage and never throws on disk errors', () => {
    const ledger = new Ledger({
      dir: path.join(dir, 'file-not-dir'),
      sessionId: 's',
      repo: 'r',
      branch: null,
      pricing,
    });
    fs.writeFileSync(path.join(dir, 'file-not-dir'), 'block the mkdir');
    expect(ledger.record('code-fast', null, 5)).toBeNull();
    expect(() =>
      ledger.record('code-fast', { prompt_tokens: 1, completion_tokens: 1, cached_tokens: 0 }, 5),
    ).not.toThrow();
  });

  it('sums month-to-date across sessions, skipping corrupt lines', () => {
    const file = path.join(dir, monthFileName(new Date('2026-06-10T12:00:00Z')));
    fs.writeFileSync(
      file,
      JSON.stringify({ cost_usd: 0.5 }) + '\n' + 'corrupt{line\n' + JSON.stringify({ cost_usd: 0.25 }) + '\n',
    );
    const ledger = makeLedger();
    expect(ledger.monthToDate()).toEqual({ costUsd: 0.75, calls: 2 });
  });

  it('returns zeros when no ledger file exists yet', () => {
    expect(makeLedger().monthToDate()).toEqual({ costUsd: 0, calls: 0 });
  });
});
