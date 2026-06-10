# GOALS — ARKS Code v1

## Objective

A terminal-based agentic coding assistant ("ARKS Code") that ARKS developers run
in any repo. Functionally equivalent to Claude Code's core loop: conversational
REPL, file/shell tools, permission gates, git-native workflow — but talking
exclusively to the ARKS AI Gateway (LiteLLM, OpenAI-compatible) and logging
per-session cost. Single binary-style install (`npm i -g`), zero per-repo setup
beyond an optional AGENTS.md.

## Success criteria (testable)

1. `arks` launched inside a git repo starts a streaming REPL; `arks "task"`
   runs one-shot mode and exits with code 0 on success.
2. The agent can, unaided, complete this acceptance task in a sample repo:
   "read AGENTS.md, find the failing test, fix the bug, run the tests, commit
   on a new branch with a conventional message" — with each file edit and
   shell command surfaced for approval first.
3. All seven core tools work and are unit-tested: read_file, write_file,
   edit_file (unique-match string replace), bash, grep, glob, todo.
4. Permission gates: file writes/edits and shell commands require y/n approval;
   `--yolo` flag and per-session "always allow" lists bypass; the git deny-list
   (force-push, hard reset, clean -fd, checkout -- ., branch -D) ALWAYS
   requires explicit confirmation even in yolo mode.
5. AGENTS.md (and CLAUDE.md as fallback) auto-loads into the system prompt
   from repo root and any parent up to the git root.
6. Context compaction: when the conversation exceeds a configurable token
   threshold, older turns are summarized into a compact note and the loop
   continues without user-visible failure.
7. Cost ledger: every session writes one JSONL record per model call
   (timestamp, model, tokens in/out/cached, computed cost, repo, git branch)
   to ~/.arks-code/ledger/, and `/cost` in the REPL shows the running session
   total.
8. Gateway integration: model aliases come from config (default code-fast;
   `/model code-deep` switches mid-session); auth via ARKS_LLM_KEY env var;
   base URL via config. Streaming via SSE works against the live gateway.
9. The full acceptance task in (2) completes against the REAL gateway using
   code-fast in under 5 minutes wall-clock.
10. `npm test` green, strict TypeScript clean, README covers install + config
    + first session.

## Constraints

- TypeScript, Node 20+. Minimal dependencies (commander/ink-or-readline,
  no heavy frameworks). Single package.
- Provider lock: OpenAI-compatible chat-completions with tool calling. No
  provider abstraction layer — the gateway IS the abstraction.
- No telemetry anywhere except the local cost ledger.
- Cross-platform: must run on Windows (PowerShell), macOS, Linux. Shell tool
  uses the platform default shell.

## Out of scope for v1 (parked, not forgotten)

- Web UI (OpenHands covers this until v2)
- IDE extensions, MCP client support, subagents/parallel agents
- Central ledger sync (v1 is local JSONL; gateway Postgres already has the
  server-side truth)
- Auto-context from embeddings/code search beyond grep/glob

## Definition of done

- [ ] All ten success criteria demonstrably met
- [ ] Acceptance task recorded as a repeatable script (test/acceptance.md)
- [ ] AGENTS.md in this repo updated with anything learned
- [ ] Tagged v0.1.0, installable via `npm i -g` from the repo
