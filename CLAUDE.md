# CLAUDE.md — ARKS Code repo

You are building ARKS Code v1: a terminal agentic coding assistant per GOALS.md
and SDD.md in this repo. Those two documents are the contract; this file is how
you work.

## Stack
TypeScript strict, Node 20+, single npm package. Keep dependencies minimal and
justified in the PR description. No telemetry. Cross-platform (Windows
PowerShell, macOS, Linux) — test path handling accordingly.

## Working rules
1. SDD section numbers are normative. If implementation needs to deviate,
   STOP and propose the deviation with reasoning before coding it.
2. Milestone discipline: implement in the order of the build plan, one
   milestone per commit series. After each milestone: run tests, report.
3. Every tool in tools/ ships with unit tests in the same commit.
4. The deny-list (policy/denylist.ts) is security-critical: every pattern gets
   a positive and negative test case.
5. The agent loop (agent/loop.ts) stays under 80 lines excluding types.
   Complexity belongs in tools/ and policy/, never in the loop.
6. Errors from tools return to the model as text. The process must never crash
   from a tool failure. Prove it with a test.
7. No secrets in code or fixtures. ARKS_LLM_KEY only ever read from env.
8. Commits: type(scope): imperative. Branch per milestone.

## Verification commands
npm ci / npm test / npm run lint / npm run build
Acceptance (manual, live gateway): see test/acceptance.md once written.

## Known landmines
- SSE tool-call deltas arrive fragmented across chunks; arguments are partial
  JSON strings that must be concatenated before parsing. Fixtures first.
- edit_file uniqueness: whitespace-exact matching; document this in the tool
  description so the model re-reads files before editing.
- Windows: no ANSI assumptions beyond what Node's readline supports; shell is
  powershell.exe unless SHELL is set.
