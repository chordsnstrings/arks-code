# ARKS Code

A terminal-based agentic coding assistant for ARKS developers. Conversational
REPL, file/shell tools behind permission gates, git-native workflow — talking
exclusively to the ARKS AI Gateway (LiteLLM, OpenAI-compatible), with
per-session cost logged locally. No telemetry.

## Install

Requires Node 20+.

```sh
git clone <this repo> && cd arks-code
npm ci && npm run build
npm i -g .
```

## Configure

1. Export your gateway key (never stored anywhere by ARKS Code):

   ```sh
   export ARKS_LLM_KEY=sk-...
   ```

2. First run prompts for the gateway base URL and writes
   `~/.arks-code/config.json`:

   ```json
   {
     "baseURL": "https://gateway.arks.internal/v1",
     "defaultModel": "code-fast",
     "compactThreshold": 80000,
     "alwaysAllow": { "fileWrite": false, "shell": false },
     "pricing": {
       "code-fast": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028 },
       "code-deep": { "input": 0.14, "output": 0.28, "cacheRead": 0.0028 }
     }
   }
   ```

   Pricing is USD per 1M tokens (`input` = cache miss, `cacheRead` = cache
   hit). Defaults reflect DeepSeek rates verified 2026-06-10; adjust when the
   gateway's upstream pricing changes.

Environment overrides: `ARKS_LLM_BASE_URL`, `ARKS_LLM_MODEL`. `ARKS_LLM_KEY`
is required and read from the environment only.

## First session

```sh
cd your-repo
arks                       # interactive REPL
arks "fix the failing test"   # one-shot: run task, print result, exit
arks --model code-deep     # model override for this session
arks --yolo                # skip approval gates (deny-list still active)
```

In the REPL:

```
ARKS Code v0.1.0 · code-fast · your-repo · main · gateway.arks.internal
❯ read AGENTS.md, find the failing test, fix the bug, run the tests
```

Every file write/edit and shell command is shown to you (full diff or exact
command) for approval first: `y`es / `n`o / `a`lways this session / `d` for
more context.

### Slash commands

| Command | Effect |
|---|---|
| `/model <alias>` | switch model (validated against the gateway's `/models`) |
| `/cost` | session + month-to-date spend from the local ledger |
| `/compact` | force context compaction now |
| `/clear` | new conversation, same session |
| `/help` | command list |
| `/quit` | exit (Ctrl+C twice also exits; once cancels the current call) |

## Permissions & the deny-list

Approval states per action class (file writes, shell): ask (default),
always-allow (persisted in config), session-allow (the `a` answer), or
`--yolo`. Regardless of mode, these always require an explicit `y`:

- `git push --force`/`-f`, `git reset --hard`, `git clean -f`,
  `git checkout -- .`, `git branch -D`, `git rebase -i`, `git filter-branch`,
  `git update-ref -d`
- `sudo`, `curl … | sh`, `rm -rf` targeting paths outside the repo root
- any file write outside the repo root

## Project instructions

ARKS Code auto-loads `AGENTS.md` (falling back to `CLAUDE.md`) from the
working directory and every parent up to the git root into the system prompt —
nearest file last, so the most specific instructions win. No other per-repo
setup is needed.

## Cost ledger

Each model call appends one JSONL record (timestamp, session, repo, branch,
model, tokens in/out/cached, computed cost, duration) to
`~/.arks-code/ledger/YYYY-MM.jsonl`. This is the only place anything is
logged, and it never leaves your machine.

## Development

```sh
npm ci          # install
npm test        # unit + integration + e2e (no network; mock gateway)
npm run lint    # eslint
npm run build   # tsc → dist/
```

Live-gateway acceptance procedure: see `test/acceptance.md`.
Architecture and the build contract: `SDD.md`, `GOALS.md`, `CLAUDE.md`.
