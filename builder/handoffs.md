# Builder handoffs: Pyrycode Relay

Read this when a run is going to end without a PR of its own, when you need to file a bug ticket, or when a size limit is a close call. Each handoff below routes the ticket by label, because the dispatcher reads labels and never reads comments.

If the runtime note appended to your instructions gives an outcome status for a handoff, return that status, putting the comment's content in your explanation, instead of posting the comment and adding the label yourself. Steps that change other state, such as a blocked-by link, still apply.

Write nothing in the worktree on any of these paths. The dispatcher commits anything left dirty to `feature/<ticket>` and pushes it, so a draft written while sketching ends up as junk on the branch. Bodies and notes go under `/tmp/builder-relay-<ticket>/`.

## Oversized or newly expanded scope

Follow [builder scope reassessment](../docs/builder-scope-handoff.md) before planning, during implementation and on repair. The builder proposes smaller useful results and stops further expansion. The orchestrator assesses the evidence and applies any split. Preserve existing work at every depth. Use `needs_scope_review` on Codex or `error:builder:scope` through the managed workflow bridge on Claude.

## Real dependency on an in-flight ticket

Use this only when the overlap check found a real dependency: your design needs what the other branch adds, or both rewrite the same block. Write no plan.

1. Mark this ticket as blocked by each ticket it depends on:

   ```bash
   gh api graphql -f query='mutation($issueId: ID!, $blockingIssueId: ID!) {
     addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
       issue { number }
     }
   }' -f issueId="$(gh issue view <THIS> --json id -q '.id')" \
      -f blockingIssueId="$(gh issue view <THAT> --json id -q '.id')"
   ```

2. Comment on this ticket: *"Blocked by #N: this design needs <what #N adds> / rewrites <the same block> as #N. Will build once #N lands."* Add any design notes the next run needs, because the refiner is not involved and this comment is what the next run reads.
3. Add `needs-rework:refiner` and stop.

Because the ticket now has an open blocker, the dispatcher treats this as a wait, not a rework. It strips the label, leaves the ticket in In Development and counts no rework. When the blocker closes, you run again with the merged code on `main`.

Any shared file used to be a reason to stop. Pyrycode #40 collided with #38 and #39 on one test file with no logical dependency and took about 30 minutes to merge by hand, and #182 and #187 repeated it. Since 2026-09-23 the dispatcher merges `main` before every stage and hands conflicts to the builder, so only a real dependency waits.

## Ticket too vague to plan

When a cold reader could not turn the acceptance criteria into tests, the context cannot be recovered from the repo, the `Estimate:` line is missing, or the ticket asks the relay to read a payload or invent wire behaviour, comment naming exactly what is missing or wrong, add `needs-rework:refiner`, and stop. A ticket that only needs a documentation change is not vague: carry that in the Documentation handoff and build.

## Filing an out-of-scope bug

Your own ticket still goes on to its PR. First capture the failing test: either commit it in a state that shows the bug, or skip it with `t.Skip("blocked on #N: <summary>")` and a platform guard where one fits. Then file the bug and put it on the board. `gh issue create` alone is not enough: an issue that is not a project item, or has no Status, is invisible to every column query the dispatcher runs.

```bash
# a. The body: smallest reproduction, expected against actual, the symbol where
#    the bug lives (not a line number), and a link to the test that surfaced it.
mkdir -p /tmp/builder-relay-<ticket>
BUG=/tmp/builder-relay-<ticket>/bug.md
cat > "$BUG" <<'EOF'
<body>
EOF
url=$(gh issue create --repo pyrycode/pyrycode-relay \
  --title "<one-line bug summary>" --label bug --body-file "$BUG")

# b. Add it to board #3, resolving the Status field and its Inbox option at run
#    time. Option IDs are reissued when the field changes, so never hardcode them.
item_id=$(gh project item-add 3 --owner pyrycode --url "$url" --format json --jq '.id')
project_id=$(gh project view 3 --owner pyrycode --format json --jq '.id')
field_json=$(gh project field-list 3 --owner pyrycode --format json)
status_field_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .id')
inbox_option_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "Inbox") | .id')

# c. Set Status to Inbox. Adding the item does not set Status on its own.
gh project item-edit --project-id "$project_id" --id "$item_id" \
  --field-id "$status_field_id" --single-select-option-id "$inbox_option_id"
```

Inbox is for human triage, and the operator promotes the ticket to Backlog when it is ready. Put the bug ticket's link in the test's skip message or comment, commit, and note the skipped assertion and the new ticket in your PR body. The bug ticket then goes through the refiner and a builder of its own.

In the rare case where your ticket's own test cannot be written at all without the bug fix, comment with a one-line explanation and add `needs-rework:refiner`, so the refiner can make the bug ticket a blocker.
