# AGENTS.md — arks-code

Instructions for agents (and humans) working in this repo. The product spec is
GOALS.md + SDD.md; how to work here is CLAUDE.md. This file records the layout
and what we learned building v0.1.0.

## Commands

```sh
npm ci          # install (Node 20+)
npm test        # vitest: unit + integration (mock gateway) + e2e (built CLI, local SSE server)
npm run lint    # eslint (typescript-eslint strict-ish)
npm run build   # tsc → dist/   (e2e tests skip if dist/ is missing — build first)
```

`npm test` needs no network and no ARKS_LLM_KEY. Live-gateway acceptance is
manual: test/acceptance.md.

## Layout (matches SDD §1)

- `src/cli.ts` — arg parsing, first-run init, REPL vs one-shot dispatch
- `src/agent/loop.ts` — THE core loop; **must stay ≤80 lines excluding types**
  (test/agent-loop.test.ts enforces this with a line-count guard)
- `src/agent/context.ts` — system prompt, AGENTS.md chain, compaction
- `src/tools/` — registry + 7 tools; `executeCall` NEVER throws
- `src/policy/` — permission engine + deny-list (every pattern has a positive
  AND negative test in test/denylist.test.ts — keep it that way)
- `src/gateway/client.ts` — SSE streaming, tool-call delta assembly, retries
- `src/ledger/ledger.ts` — JSONL cost records; must never throw into a session
- `src/repl/` — readline UI, approval prompts, slash commands, Session wiring

## Learnings from the v1 build (keep these in mind)

1. **SSE tool-call deltas really do fragment mid-JSON-string.** Assembly is
   keyed by `index`, concatenating `function.arguments` fragments; parse only
   after the stream ends. Fixtures: test/fixtures/sse.ts (also covers one SSE
   event split across two network chunks — handle partial lines).
2. **SDD §2 pseudocode vs OpenAI protocol:** tool results must FOLLOW the
   assistant message that carries tool_calls. We deviate from the SDD's
   append order (documented in loop.ts). Compaction must never cut between an
   assistant tool_calls message and its tool results.
3. **edit_file is whitespace-exact** — the tool description tells the model to
   re-read before editing; error messages repeat it. Don't soften the
   uniqueness rule; 0 and >1 matches both reject.
4. **Windows:** shell is powershell.exe unless SHELL is set; cwd persistence
   uses a sentinel line per shell kind (see tools/shell.ts `wrapCommand`).
   Don't assume ANSI beyond Node readline; honor NO_COLOR.
5. **Deny-list `rm -rf` is path-aware**, not regex-only: targets are resolved
   against the session cwd and compared to the repo root. `../sibling` from a
   subdir can still be inside the repo — test expectations accordingly.
6. **Ledger and compaction failures must degrade silently** (a dim note at
   most): disk errors or a failed summarization call never break a turn.
7. **e2e tests drive the built CLI over a real local HTTP/SSE server**
   (test/fixtures/sse-server.ts). For REPL interactions, wait for output
   markers before writing the next stdin line — closing stdin early kills
   readline mid-turn.

8. **npm bin symlinks break naive entry guards.** Comparing argv[1] verbatim
   against import.meta.url fails when invoked via the global symlink — that
   shipped as `arks` printing nothing and exiting 0. The bin target is
   src/bin.ts, which runs main() unconditionally and turns any startup error
   into stderr + exit 1; cli.ts keeps a realpath-aware guard only for direct
   `node dist/cli.js` runs. Regression tests execute the binary THROUGH a
   symlink (test/e2e-bin.test.ts); keep them when touching the entry path.

## Conventions

- TypeScript strict; ESM (NodeNext) — internal imports need the `.js` suffix.
- Commits: `type(scope): imperative summary`.
- Every tool change ships with its unit tests in the same commit.
- No secrets in code or fixtures; ARKS_LLM_KEY only ever read from env.
