# KICKOFF PROMPT — paste as the first message of the first Claude Code session

You are starting the ARKS Code v1 build.

Read, in order: CLAUDE.md, GOALS.md, SDD.md.

Then, before writing any code:
1. Restate the objective in 2–3 sentences.
2. Produce a build plan of 6–8 milestones, ordered so that something runnable
   exists as early as possible. Suggested shape (adjust if you see better):
   M1 scaffold + config + gateway client with streaming (smoke-testable
   against a mock); M2 tool registry + fs/search/todo tools with tests;
   M3 agent loop against mock gateway; M4 permission gates + deny-list;
   M5 REPL UI + slash commands; M6 context/AGENTS.md/compaction; M7 ledger +
   /cost; M8 acceptance hardening + README + v0.1.0.
3. For each milestone: files created/modified, which GOALS success criteria it
   serves, and its test evidence.
4. Flag anything ambiguous or contradictory across the three documents NOW.
5. Wait for my confirmation. Then implement milestone by milestone — after
   each: run the tests, show me a short report, pause if anything deviates
   from the SDD.

Rules of engagement: CLAUDE.md is binding. If a milestone fails twice,
stop and report rather than thrash.
