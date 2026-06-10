# Acceptance test — GOALS criterion 2 & 9 (live gateway)

A repeatable, manual live-fire test against the REAL ARKS AI Gateway. CI never
runs this (CI uses the mock gateway); a human runs it before tagging a release.

Target: the agent completes the task unaided in **under 5 minutes wall-clock**
on `code-fast`, with every file edit and shell command surfaced for approval.

## Prerequisites

```sh
export ARKS_LLM_KEY=sk-...           # your gateway key
# ~/.arks-code/config.json has the gateway baseURL (or export ARKS_LLM_BASE_URL)
npm i -g .                            # from this repo, after npm ci && npm run build
```

## 1. Create the sample repo

```sh
rm -rf /tmp/arks-acceptance && mkdir -p /tmp/arks-acceptance && cd /tmp/arks-acceptance
git init -b main

cat > AGENTS.md <<'EOF'
# Sample project
Run tests with: node --test
The math module lives in math.js. Keep the API unchanged.
Commit style: type(scope): summary.
EOF

cat > math.js <<'EOF'
// classic off-by-one: should be i <= n
function sumUpTo(n) {
  let total = 0;
  for (let i = 1; i < n; i++) total += i;
  return total;
}
module.exports = { sumUpTo };
EOF

cat > math.test.js <<'EOF'
const test = require('node:test');
const assert = require('node:assert');
const { sumUpTo } = require('./math.js');

test('sums 1..n inclusive', () => {
  assert.strictEqual(sumUpTo(4), 10);
});
EOF

git add -A && git commit -m "chore: seed sample project with a failing test"
node --test    # confirm: 1 failing test
```

## 2. Run the acceptance task

```sh
cd /tmp/arks-acceptance
time arks "read AGENTS.md, find the failing test, fix the bug, run the tests, commit on a new branch with a conventional message"
```

## 3. Verify (all must hold)

- [ ] The agent read AGENTS.md (tool line `⏺ read AGENTS.md` appeared).
- [ ] It located the bug in `math.js` (via grep/read/running the tests).
- [ ] The `edit_file` change was shown as a diff and **required your y** before
      being applied.
- [ ] Every shell command (`node --test`, `git ...`) was shown and **required
      your y** (no `--yolo` in this run).
- [ ] Tests pass afterwards: `node --test` exits 0.
- [ ] `git log --oneline -1` shows a conventional message
      (e.g. `fix(math): include n in sumUpTo`) on a NEW branch
      (`git branch --show-current` ≠ main).
- [ ] The agent never pushed, never used `--force` anything.
- [ ] `time` reports < 5 minutes (criterion 9).
- [ ] Exit code 0 (`echo $?`).

## 4. Verify the ledger (criterion 7)

```sh
tail -3 ~/.arks-code/ledger/$(date -u +%Y-%m).jsonl
```

- [ ] One record per model call with `repo: "arks-acceptance"`, the branch,
      model `code-fast`, token counts and a nonzero `cost_usd`.

## 5. Spot-check the REPL extras

```sh
arks   # in the same sample repo
```

- [ ] Header line shows version · model · repo · branch · gateway host.
- [ ] `/cost` shows the session and month-to-date totals.
- [ ] `/model code-deep` switches (validated against gateway `/models`).
- [ ] `git push --force` requested via a task prompts even with `--yolo`.
- [ ] Ctrl+C during a streaming reply cancels it; Ctrl+C twice exits.

## Recording results

Note date, gateway host, model, wall-clock time, and any deviations in the PR
or release notes. Two consecutive failures of this script block the release
(CLAUDE.md rules of engagement).
