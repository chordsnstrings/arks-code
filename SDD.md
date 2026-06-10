# SDD — ARKS Code v1

## 1. Architecture overview

```
┌─ cli.ts ──────────── arg parsing, REPL vs one-shot, signal handling
│
├─ repl/ ───────────── terminal UI: streaming renderer, input, approval prompts,
│                      slash commands (/model /cost /compact /clear /help /quit)
│
├─ agent/
│   ├─ loop.ts ─────── THE core: ≤80 lines. while(true): call model →
│   │                  if tool_calls: gate → execute → append results → continue
│   │                  else: render final text → break
│   ├─ context.ts ──── system prompt assembly, AGENTS.md discovery, compaction
│   └─ prompts.ts ──── system prompt template incl. git conventions (§6)
│
├─ tools/
│   ├─ registry.ts ─── tool schema definitions (OpenAI function format)
│   ├─ fs.ts ───────── read_file, write_file, edit_file, glob
│   ├─ shell.ts ────── bash (cross-platform), output capture + truncation
│   ├─ search.ts ───── grep (ripgrep if present, JS fallback)
│   └─ todo.ts ─────── in-session plan/task list the model maintains
│
├─ gateway/
│   └─ client.ts ───── OpenAI-compatible chat completions, SSE streaming,
│                      tool-call delta assembly, retry (2x, backoff), usage capture
│
├─ policy/
│   ├─ permissions.ts ─ approval gates, allow-lists, --yolo, git deny-list
│   └─ denylist.ts ──── destructive command patterns (regex, tested)
│
├─ ledger/
│   └─ ledger.ts ────── JSONL writer, pricing table, session totals
│
└─ config/
    └─ config.ts ────── ~/.arks-code/config.json + env overrides
```

## 2. The agent loop (normative)

```
messages = [system(context), user(task)]
loop:
  resp = gateway.stream(model, messages, tools)        # render text deltas live
  if resp.tool_calls is empty: break
  for call in resp.tool_calls:
    if !policy.allowed(call): result = await promptUser(call)   # approve/deny/always
    if denied: result = "User denied this action."
    else:      result = tools.execute(call)             # never throws; errors → text
    messages.append(tool_result(call.id, truncate(result, 30_000 chars)))
  messages.append(assistant(resp))
  if tokens(messages) > config.compactThreshold: context.compact(messages)
```

Rules: tool errors are returned to the model as text, never crash the loop;
Ctrl+C once cancels the current model call, twice exits; max 50 iterations
per user turn, then the agent must stop and report.

## 3. Tool contracts

| Tool | Params | Behavior / hard rules |
|---|---|---|
| read_file | path, offset?, limit? | Returns numbered lines. >2000 lines → return slice + note. Binary → refuse with type info. |
| write_file | path, content | Creates dirs as needed. GATED. |
| edit_file | path, old_str, new_str | old_str must match exactly once; 0 or >1 matches → error telling the model to re-read. GATED. |
| bash | command, timeout?=120s | Platform shell. cwd persists per session. stdout+stderr interleaved, >30k chars → head+tail truncate. GATED (see §5). |
| grep | pattern, path?, glob? | ripgrep if on PATH else JS scan. Max 200 hits. |
| glob | pattern | Sorted by mtime desc. Respects .gitignore. |
| todo | items[] {text,status} | Replaces the session plan; rendered as a checklist in the REPL. |

All tools: paths resolved relative to launch cwd; absolute paths outside the
repo root require approval even in yolo mode.

## 4. Context assembly

System prompt = base persona + tool usage rules + git conventions (§6)
+ environment block (os, cwd, git branch, date)
+ AGENTS.md chain: walk from cwd up to git root, concatenate every AGENTS.md
  (fallback CLAUDE.md) found, nearest last (highest precedence).

Compaction: at threshold (default 80k tokens), replace all but the last 6
turns with a single assistant note produced by a summarization call on
code-fast: decisions made, files touched, current task state, open items.

## 5. Permission model

States per action class {fileWrite, shell}: ask (default) | session-allow |
always-allow (persisted in config) | yolo (CLI flag, this session).

Approval prompt renders the full diff (edit/write) or the exact command (bash)
before asking. Responses: y / n / a (always this session) / d (show more).

GIT DENY-LIST — these patterns require explicit y even under yolo/always:
push --force | push -f | reset --hard | clean -f | checkout -- . |
branch -D | rebase (interactive) | filter-branch | update-ref -d
Plus non-git: rm -rf outside repo root, sudo, curl|sh patterns.
Deny-list lives in policy/denylist.ts as tested regexes.

## 6. Git conventions (system-prompt text, normative content)

The agent must: run `git status` and `git diff` before any commit and describe
what changed; never commit without having shown the user the changes (the
approval gates naturally enforce this); work on a branch per task
(`feature/<slug>` or `fix/<slug>`) created from the current branch unless told
otherwise; write commits as `type(scope): imperative summary`; never push
unless asked; never amend or rewrite history unless asked; if `gh` CLI is
available and the user asks for a PR, use it — title from branch, body from
the session todo list.

## 7. Gateway client

- POST {baseURL}/chat/completions, stream: true, tools per registry.
- Assemble tool_call deltas across SSE chunks (id + function.name +
  arguments fragments) — this is the fiddly part; unit-test with recorded
  chunk fixtures.
- Capture `usage` (incl. prompt_cache_hit_tokens / cache miss if present —
  the gateway passes DeepSeek's fields through) for the ledger.
- Retries: 2 on network/5xx with 1s/4s backoff. 4xx → surface to user verbatim.
- Timeouts: connect 10s, total per call 600s (code-deep thinks long).

## 8. Cost ledger

~/.arks-code/ledger/YYYY-MM.jsonl, one record per model call:
{ts, session_id, repo, branch, model, prompt_tokens, completion_tokens,
 cached_tokens, cost_usd, duration_ms}
Pricing table in config (per-model in/out/cache per 1M) with defaults for
code-fast / code-deep — VERIFY current DeepSeek rates at api-docs.deepseek.com
and put real numbers in config defaults at build time.
/cost renders session totals + month-to-date from the JSONL.

## 9. Config

~/.arks-code/config.json:
{ baseURL, defaultModel: "code-fast", compactThreshold: 80000,
  alwaysAllow: {fileWrite:false, shell:false}, pricing: {...} }
Env overrides: ARKS_LLM_KEY (required), ARKS_LLM_BASE_URL, ARKS_LLM_MODEL.
First run with no config → interactive init (prompt for base URL, write file).

## 10. Testing strategy

- Unit: tools (tmp-dir fixtures), denylist regexes, edit_file uniqueness,
  SSE tool-call assembly (recorded fixtures), ledger math.
- Integration: agent loop against a MOCK gateway (canned tool-call scripts) —
  no network in CI.
- Acceptance: scripted live run of GOALS criterion 2 against the real gateway
  (manual, documented in test/acceptance.md).
