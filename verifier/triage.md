# Triage: Pyrycode Relay verifier

Read this when your gate note says **TRIAGE MODE**, or when no gate note arrived and you run the gates yourself. The goal is to decide, mechanically where possible, whether this PR caused the red. A PR that fixes one thing while unmasking older fragility elsewhere should not be sent back for rework it cannot do. Before this procedure existed, such PRs burned three or more rework cycles.

The snippets below assume bash, because they use process substitution. Run them with `bash -c` if your shell is something else. Scratch files: `$V/check.log`, `$V/build.log`, `$V/baseline-check.log`, `$V/review.md`, `$V/bug.md`.

## Running the gates yourself

Only when no gate note was injected. Run them once, in this order, then follow the matching path: green goes to judgment, red goes through this file using your own logs.

```bash
make check 2>&1 | tee "$V/check.log"
make build 2>&1 | tee "$V/build.log"
```

## Classify the red

The injected failure context names the failing gate and carries its output. Classify before anything else:

| Observed | Classification | Next action |
|---|---|---|
| `make build` failed | **red (build failure)** | Always a regression, because the PR's tree does not compile. `needs-rework:builder` immediately, with no baseline run. |
| `make check` stopped in `go vet` | **red (vet failure)** | Compare against the baseline's vet output, below. A vet finding the baseline lacks is a regression: `needs-rework:builder`. |
| `make check` failed and failing tests are extractable | **red (check failure)** | Run the baseline comparison below. Routing depends on the split between regressions and pre-existing failures. |
| Non-zero exit but no parseable failing test names and no vet failure | **infra failure** | Post the infra template. Do not route to rework on this signal alone. Go on to judgment; your verdict alone decides. |

Check the build and vet rows before concluding "infra failure". The table is ordered that way on purpose. The relay's `make check` is `vet` then `test`, and make stops at the first failing step, so a vet finding means the tests never ran and the log has no `--- FAIL: TestName` line at all. It would otherwise be misfiled as an infra anomaly. Detect it first:

```bash
grep -nE '^make(\[[0-9]+\])?: \*\*\* .*vet' "$V/check.log"    # make names the failing vet target
grep -nE '^[^ ]+\.go:[0-9]+:[0-9]+: ' "$V/check.log"             # the vet findings themselves
```

If that matches, classify **red (vet failure)**. Run `go vet ./...` once in a baseline worktree, using the same `git worktree add --detach` recipe as the baseline comparison, and compare the findings by file and message, ignoring line numbers. Any finding the baseline lacks is the PR's: route to `needs-rework:builder` with the vet output quoted. If every finding also appears on the baseline, it is pre-existing. Track it through the search-first dedupe below, with `go vet` as the check name. Then run `go test -race ./... 2>&1 | tee "$V/check.log"` once in the PR worktree, because vet stopped make before the tests could run, and classify that log as a check failure or green. There is no CI on this repo, so `main` is only as clean as the last dispatcher gate left it. Do not assume a vet finding on the PR must be the PR's.

**Getting the PR-side log.** Prefer the injected context: if it holds the full `make check` output, save it to `$V/check.log`. If it is only an excerpt without parseable `--- FAIL:` lines on a check-tier failure, reproduce once in the PR worktree with `make check 2>&1 | tee "$V/check.log"` to capture the full log. That reproduction is triage, not a judgment-mode gate re-run. It is the one situation where you run `make check` yourself, apart from the case with no gate note.

Extract failing test names. Go prints `--- FAIL: TestName (...)` per failing test, and subtests as `--- FAIL: TestParent/subname`. The extraction keeps the full path, which is what `go test -run` accepts later:

```bash
grep -E '^--- FAIL: ' "$V/check.log" | awk '{print $3}' | sort -u
```

## Baseline comparison for a red check

Do not route a check failure to `needs-rework:builder` on sight. Re-run `make check` against the PR's merge-base in a temporary worktree, then classify each failing test as `regression` (passed on baseline, failed on PR) or `pre_existing` (failed on both). Skip the baseline run entirely on a build failure or an infra failure. A vet failure runs only the vet comparison above. On this module the baseline run adds well under a minute.

This answers "did this PR introduce these failures?" mechanically, with no diff reasoning or call-graph guessing. It is a deterministic check under your first classification, which is a different kind of check from a second prompt rule and does not share its blind spots.

```bash
# 1. PR-side failing test names, already extracted above:
PR_FAILS=$(grep -E '^--- FAIL: ' "$V/check.log" | awk '{print $3}' | sort -u)
if [ -z "$PR_FAILS" ]; then
  # Defensive: red:check without parseable names should have classified as
  # infra-failure. If it didn't, fall through to standard red routing.
  echo "verifier: red:check with no parseable failing names; routing as standard red" >&2
else
  # 2. Resolve baseline ref. The merge-base captures "where this PR diverged from main."
  BASELINE_REF=$(git merge-base HEAD origin/main 2>/dev/null)
  if [ -z "$BASELINE_REF" ]; then
    echo "verifier: merge-base unresolved; routing as standard red" >&2
  else
    # 3. Detached worktree at the baseline. `git worktree add` accepts an
    #    existing EMPTY directory, which is what mktemp -d gives us.
    BASELINE_DIR=$(mktemp -d -t baseline-verifier-XXXXXX)
    if ! git worktree add --detach "$BASELINE_DIR" "$BASELINE_REF" >/dev/null 2>&1; then
      echo "verifier: baseline worktree add failed; routing as standard red" >&2
      rmdir "$BASELINE_DIR" 2>/dev/null || true   # nothing was checked out; don't leak the dir
    else
      # 4. Run make check in the baseline worktree. `&>` captures BOTH stdout and
      # stderr: `go vet` writes to stderr and we need it in the log for accurate
      # comparison. (`2>&1 > file` is wrong-ordered and would leak stderr.)
      (cd "$BASELINE_DIR" && make check) &> "$V/baseline-check.log" || true
      if [ -s "$V/baseline-check.log" ]; then
        BASELINE_FAILS=$(grep -E '^--- FAIL: ' "$V/baseline-check.log" | awk '{print $3}' | sort -u)
        # 5. Partition: comm -23 = in PR_FAILS only (regressions, PR caused them);
        #    comm -12 = in both (pre_existing, PR did not cause them).
        REGRESSIONS=$(comm -23 <(echo "$PR_FAILS") <(echo "$BASELINE_FAILS"))
        PRE_EXISTING=$(comm -12 <(echo "$PR_FAILS") <(echo "$BASELINE_FAILS"))
      else
        echo "verifier: baseline log empty or not produced; routing as standard red" >&2
        REGRESSIONS="$PR_FAILS"
        PRE_EXISTING=""
      fi
      # 6. Clean up the baseline worktree, always. Leaks rot the dispatcher's worktree list.
      git worktree remove --force "$BASELINE_DIR" >/dev/null 2>&1 || true
    fi
  fi
fi
```

**Routing after the comparison.** Three cases:

1. **`REGRESSIONS` non-empty.** At least one failing test passed on the baseline but fails on this PR. Post the standard-red template, add `needs-rework:builder`, and stop there, skipping judgment. The diff you would review is about to change. If `PRE_EXISTING` is also non-empty, mention those too, flagged as "pre-existing, tracked separately", and run the search-first dedupe before posting so the linkage is in the comment.
2. **`REGRESSIONS` empty and `PRE_EXISTING` non-empty.** Every failing test fails on the baseline too, so the PR did not introduce them. Track the `PRE_EXISTING` set through the search-first dedupe, post the out-of-scope-red template, add no labels from the triage half, then go on to judgment in this same run. The PR itself is reviewable, and your judgment verdict owns the labels from here.
3. **Baseline could not run** because the merge-base was unresolved, the worktree add failed or the baseline log is missing. Fall back to standard red routing with `needs-rework:builder`. The deterministic check failed, so default to the safe behaviour.

## Redact before quoting any log

Every `<redacted tail>` in the templates below, including the standard-red tail, the build-failure tail and the tracking-ticket comment, goes through this filter first. `pyrycode/pyrycode-relay` is private, but Go test output can surface environment variables, the relay's own tests log remote hosts, and the cost of a leaked credential is high, so err toward redaction.

```bash
redact() {
  sed -E \
    -e 's/(sk-ant-[A-Za-z0-9_-]{10,})/[REDACTED-ANTHROPIC-KEY]/g' \
    -e 's/(ghp_[A-Za-z0-9]{36,})/[REDACTED-GITHUB-TOKEN]/g' \
    -e 's/(ghs_[A-Za-z0-9]{36,})/[REDACTED-GITHUB-TOKEN]/g' \
    -e 's/(ANTHROPIC_API_KEY=[^[:space:]]+)/ANTHROPIC_API_KEY=[REDACTED]/g' \
    -e 's/(GITHUB_TOKEN=[^[:space:]]+)/GITHUB_TOKEN=[REDACTED]/g' \
    -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]+/\1[REDACTED]/g' \
    -e 's/([Aa]uthorization:[[:space:]]*)[^[:space:]]+/\1[REDACTED]/g' \
    -e 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}\b/[REDACTED-IP]/g'
}

redact < "$V/check.log" | tail -n 5     # the standard-red "last 5 lines"
redact < "$V/build.log" | tail -n 10    # the build-failure "last 10 lines"
```

The injected failure context goes through the same filter before any of it is quoted. It is a raw gate log until proven otherwise.

## The tracking line

The red templates below carry a `` `<TRACKING-LINE>` `` placeholder. Replace the whole line, backticks included, with exactly one of these shapes, chosen by the KNOWN and NEW split from the search-first dedupe:

- **All KNOWN:** `Tracking (re-observed): #X (for check-A), #Y (for check-B)`
- **All NEW:** `Filed as separate bug ticket: #Z`
- **Mixed:** two lines, `Tracking (re-observed): #X (for check-A)` then `Filed as new ticket: #Z (for check-B)`

All three name the check each ticket belongs to, so the linkage is unambiguous. The placeholder is wrapped in backticks because GitHub Markdown silently strips unknown angle-bracket constructs. A bare `<TRACKING-LINE>` left unsubstituted renders as empty space, and an empty review looks valid. The backticks make an unsubstituted marker show up as visible text that a human will catch.

## Triage templates

Post every template with `gh pr comment <PR-number> --body-file "$V/review.md" --repo pyrycode/pyrycode-relay`. The pipeline's one GitHub identity also opened the PR, and GitHub refuses an author's own change-request review, so the label is what routes the ticket.

**Standard red, regressions present:**

````
❌ **Verification gates failed: regressions introduced by this PR**

Regressions (passed on baseline `<sha>`, fail on PR):
- TestName1
- TestName2

Pre-existing failures (fail on both baseline AND PR branch, NOT caused by this PR):
- TestName3

`<TRACKING-LINE>`

Last 5 lines of `make check`:
```
<redacted tail>
```
````

Then run `gh issue edit <ticket-number> --add-label needs-rework:builder --repo pyrycode/pyrycode-relay`. If `PRE_EXISTING` is empty, drop the pre-existing block and the tracking line from the template.

**Out-of-scope red, all failures pre-existing.** Run the search-first dedupe first, then post:

```
⚠️ **Verification gates RED: pre-existing failures (PR did not cause them)**

Failing test(s): <PR_FAILS, comma-separated>

Baseline-comparison verdict (run against `git merge-base HEAD origin/main`):
- Regressions introduced by this PR: **none**
- Pre-existing failures (fail on both baseline AND PR branch): <PRE_EXISTING, comma-separated>

Triage verdict: PASS (PR did not introduce these failures).

`<TRACKING-LINE>`

Continuing to judgment review in this run.
```

No labels from the triage half on this path: no `needs-rework:*` and no `done:*`. The judgment verdict owns the labels from here.

**Build failure:**

````
❌ **Verification gates failed: build failure**

`make build` did not succeed on this PR. Build failures always route to rework, because they mean the PR's tree does not compile.

Last 10 lines of `make build`:
```
<redacted tail>
```
````

Then run `gh issue edit <ticket-number> --add-label needs-rework:builder --repo pyrycode/pyrycode-relay`.

**Vet finding the baseline lacks.** Same shape as the build failure, headed "vet finding introduced by this PR", with the new `go vet` findings quoted in place of the tail. Each already names its file and the problem. Same label.

**Infra failure, the gate could not produce a verdict:**

```
⚠️ **Verification gate could not produce a verdict**

The gate returned non-zero but produced no parseable `--- FAIL:` lines and no `go vet` failure. Likely causes: toolchain not found, OOM during build, environmental disruption.

(Name the specific anomaly visible in the log: e.g. "make: command not found", "no test output before exit", "no space left on device".)

Proceeding to judgment review in this run; its verdict alone decides PASS/FAIL on this ticket. Operator may want to re-dispatch after addressing the environmental cause.
```

No label changes from the triage half on an infra failure.

## Filing pre-existing-failure tickets: search-first dedupe

Before filing a new bug ticket for a pre-existing failure, search open issues for an existing tracking ticket. If one exists, comment and link instead of creating a new one.

Without this, every PR cycle that meets the same unmasked failure files a fresh duplicate. On 2026-05-23, `snapshot-drift` on `pyrycode/tui-driver` was filed as #75, #83 and #92 across three PR cycles in 48 hours, each closed as superseded.

For each check name in `PRE_EXISTING`:

```bash
# Search open issues whose title contains the check name, as a literal string.
# `--limit 100` (gh max) so a generic name matching many issues doesn't push
# the true tracking ticket beyond the inspection window.
candidates=$(gh issue list --repo pyrycode/pyrycode-relay --state open \
               --search "\"<check-name>\" in:title" \
               --json number,title,url --limit 100)
```

The check name is wrapped in quotes for GitHub Search's exact-string syntax. Go test names are safe as they are. If a name contains search-special characters such as `:` `(` `)` `+` `"`, backslash-escape them before substituting. A candidate qualifies as the tracking ticket for this check if its title contains the check name, ignoring case, and is shaped like a tracking ticket. Marker words include, but are not limited to, `pre-existing`, `unmasked`, `drift`, `flaky`, `tracking`, `regression`, `bug`, `failure`, `broken` and `intermittent`.

A false positive, commenting on a related but distinct issue, costs one extra notification. A false negative creates the duplicate this rule exists to prevent. So when unsure, treat it as a match and comment. If several open issues match one check, comment on the oldest, which is the canonical tracker, and link the others in the comment so they consolidate over time.

Split `PRE_EXISTING` into **KNOWN** checks, which have a matching open tracking ticket, and **NEW** checks, which do not. Record the matched number for each KNOWN check.

**For each KNOWN check,** comment on its tracking ticket. No board operations are needed, because the ticket is already on the board:

```bash
gh issue comment <matched-number> --repo pyrycode/pyrycode-relay --body \
  "Re-observed as pre-existing failure on PR #<PR-number> (baseline-comparison
  against \`<baseline-sha>\` confirms not introduced by this PR's diff).
  Tracking continues here.

  Last 5 lines of \`make check\` on PR branch: <redacted tail, fenced>"
```

**If NEW is non-empty,** file one bundled ticket for the NEW checks only. If NEW is empty, skip this block entirely. The steps share `$url`, and running them without it errors.

```bash
# A. File ONE bundled bug ticket for the NEW set. Title lists ONLY the NEW checks.
#    Body: the NEW check names, the PR #, the baseline-comparison evidence (both
#    make check tails, redacted), and "cause not yet diagnosed" unless you've
#    identified it. If KNOWN is non-empty, note those tickets too ("see also #X, #Y").
url=$(gh issue create --repo pyrycode/pyrycode-relay \
  --title "<NEW-names>: pre-existing failures unmasked by PR #<PR>" \
  --label "bug" \
  --body-file "$V/bug.md")

# A.1 Add to board #3; resolve project + Status field + Backlog option at runtime.
#     Never hardcode option IDs: updateProjectV2Field mutations reissue them
#     (2026-05-22 board-mutation lesson).
item_id=$(gh project item-add 3 --owner pyrycode --url "$url" --format json --jq '.id')
project_id=$(gh project view 3 --owner pyrycode --format json --jq '.id')
field_json=$(gh project field-list 3 --owner pyrycode --format json)
status_field_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .id')
backlog_option_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "Backlog") | .id')

# A.2 Set Status = Backlog. `gh project item-add` does NOT set Status on its
#     own; without this the item lands invisible to every column query.
gh project item-edit --project-id "$project_id" --id "$item_id" \
  --field-id "$status_field_id" --single-select-option-id "$backlog_option_id"

# A.3 Move to top of project (= top of Backlog when the column filters).
#     Omitting afterId sends the item to position 1.
gh api graphql -f query='mutation($projectId: ID!, $itemId: ID!) {
  updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId }) {
    clientMutationId
  }
}' -f projectId="$project_id" -f itemId="$item_id" > /dev/null
```

The ticket goes to the top of Backlog, not Inbox. It already carries agent-checked evidence, failing test names plus a baseline comparison showing they are not this PR's regressions, so the refiner can take it without human pre-triage. It goes to the top because an unmasked pre-existing failure means `main` has a real bug that just surfaced, which deserves priority over already-refined work.

This dedupe is a prompt-level fix. If duplicates appear again, file a follow-up on [agent-dispatcher](https://github.com/pyrycode/agent-dispatcher) for a deterministic check that refuses to create an issue when an open issue with a matching title prefix exists. Do not add that check before a repeat is seen.
