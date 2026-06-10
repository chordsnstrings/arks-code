# UX SPEC — ARKS Code v1 (terminal)

## Invocation
arks                      → REPL in cwd
arks "fix the auth bug"   → one-shot: run task, print result, exit
arks --yolo               → skip approval gates (deny-list still active)
arks --model code-deep    → override default model

## REPL layout (plain readline rendering; no full-screen TUI in v1)
- Header on start: ARKS Code v0.1 · model · repo · branch · gateway host
- Streaming assistant text renders as it arrives, markdown-lite (bold,
  code fences with subtle border, lists). No syntax highlighting in v1.
- Tool activity lines, single line each, status glyph:
  ⏺ read src/auth.ts (212 lines)
  ⏺ bash: npm test … ✓ 0.8s
- Approval prompt (blocking):
  ── EDIT src/auth.ts ─────────────────────
  - old line
  + new line
  ─────────────────────────────────────────
  Apply? [y]es [n]o [a]lways this session [d]iff context →
- Todo list renders as checklist whenever the model updates it.

## Slash commands
/model <alias>   switch model (validates against gateway /models)
/cost            session + month-to-date spend from ledger
/compact         force context compaction now
/clear           new conversation, same session
/help            command list
/quit            exit (Ctrl+C twice also exits)

## Tone & color
Minimal: dim for tool lines, default for assistant text, yellow for approval
prompts, red only for errors. Honor NO_COLOR. Cyan #0E9AAB-adjacent accent
where 256-color is available; graceful fallback otherwise.

## Errors
Gateway 4xx: show verbatim, suggest /model or key check.
Network/5xx after retries: one-line error, conversation intact, user can retry.
Tool errors: shown dim inline; the model sees them and self-corrects.
