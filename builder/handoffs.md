# Builder handoffs: Pyrycode Relay

Read this when a run is going to end without a PR of its own, when you need to file a bug ticket, or when a size limit is a close call. Each handoff below routes the ticket by label, because the dispatcher reads labels and never reads comments.

If the runtime note appended to your instructions gives an outcome status for a handoff, return that status, putting the comment's content in your explanation, instead of posting the comment and adding the label yourself. Steps that change other state, such as a blocked-by link, still apply.

Write nothing in the worktree on any of these paths. The dispatcher commits anything left dirty to `feature/<ticket>` and pushes it, so a draft written while sketching ends up as junk on the branch. Bodies and notes go under `/tmp/builder-relay-<ticket>/`.

## Oversized ticket

### Why the limits are where they are

Read this for a close call. The numbers are meant to be applied as raw counts.

- **The 800-line ceiling** was set for the builder's budget on 2026-09-02 on pyrycode, and adopted here without relay builder runs behind them. Across the builder's first 21 runs there, no run exhausted its budget: the median used 60 turns and 14 minutes, the heaviest 127 turns (#1826) and 23 minutes (#1825), and the median merged PR added about 920 lines including spec and docs. 800 lines sits inside a two-times margin of the heaviest run. The older 400-line, 3-file table was set for a smaller developer budget. Do not relax a line by reasoning that you have turns to spare. The failures on the old set were wall-clock and cascade-shaped, and the call-site line binds whatever the line count.
- **Total written work, not production lines.** On 2026-05-16 three plans applied the old production-only check, concluded they were inside it, and all three were salvaged at their budget. #432 planned about 60 lines and wrote 541 across 14 files. #445 planned about 150 production lines and wrote 2096 in total. #446 planned 75 to 110 and wrote 1071. Tests ran three to five times the production code, helpers 15 to 30 lines each, and per-reject log calls 5 to 10 lines across 10 or more branches. That is why the table counts total work and has a reject-branch line.
- **Call sites, not lines, on refactors.** #29 renamed an interface across 5 test files with about 35 net production lines and about 30 edits, sized small by lines, and ran out of budget. Relay PR #102 touched 21 files the same way. A refactor usually splits cleanly by introducing the new shape alongside the old, migrating consumers in batches, then removing the old.
- **Recounting is the warning sign.** #75 counted 26 call sites, called them "mechanical `, nil` appends collapsible to one `replace_all` per file", estimated 12 turns, and proceeded. The cascade ate 30 to 50 turns and the run was salvaged. It should have split into the interface with its default wiring, then the new verb on top. Any time a paragraph recounts something to be "really" under a limit, split. The same goes for treating tests, per-reject log calls or a constructor's validation block as free.
- **There is no larger size.** Nothing above the table has existed on this pipeline since 2026-05-02. You can find the work smaller than the refiner's estimate, never larger.

### Check the split depth first

Recursive splitting is a measured failure: #1925 became #1937, then #1940, then #1943 and #1944, in about seventy minutes with no code written. So before proposing a split, check whether the ticket is already a grandchild:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){number parent{number parent{number}}}}}' \
  -f owner="$(gh repo view --json owner --jq .owner.login)" \
  -f repo="$(gh repo view --json name --jq .name)" \
  -F num=<TICKET> \
  --jq '.data.repository.issue | "parent \(.parent.number // "none") grandparent \(.parent.parent.number // "none")"'
```

If `grandparent` is anything other than `none`, do not split, and do not stop either. Add `needs-human:sizing`, comment with the split you would have made and the measurement behind it, then build the ticket as it stands through to the PR. Once splitting is off the table the only outcomes are building it now or building it after an interruption that ends the same way. #1938, the first ticket to reach this gate, stopped anyway and paid for a full extra run without adding anything to its analysis. The label marks the judgement so a person can find it later. It is not a question someone must answer first, so state your measurement and your reading of it rather than leaving the call to the label.

### Check the floor

A slice whose only deliverable is consumed by exactly one sibling in the same family is part of that sibling, not a ticket. If your proposed split produces a child nothing outside the family calls, merge it back. When the floor and the ceiling disagree, the floor wins: merge the one-consumer slice even if the merged ticket exceeds a line of the table, state the overage in your plan, and build. The ceiling protects against a budget miss, which costs one continuation leg. The floor protects against a ticket that cannot be verified on its own, which no continuation fixes. On the #1720 split, four one-consumer pairs were cut apart to stay under the old ceiling, and ten tickets carried what five would have.

### Propose the split

Post the proposal as a comment on the ticket, then add `needs-rework:refiner` and stop. Do not write a plan for the parent, because it would be thrown away.

> **Oversized — split as follows:**
> - **A:** [first slice — what behaviour, what interfaces it introduces]
> - **B:** [second slice — what it consumes from A, what it adds; ...and so on]
>
> Each child stands alone. The refiner will write a self-contained body for each (no parent plan to reference — there's none). Each child's builder run produces its own plan from its own body.

When the split comes from the re-count of a written plan, name two or three slices at seams in your Design section. Put the proposal only in the comment and do not commit the plan.

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
