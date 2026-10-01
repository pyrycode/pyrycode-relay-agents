# Splitting and board moves: Pyrycode Relay refiner

Read this before you split a ticket, and when you need to move a ticket between columns. The decision to split is made in `CLAUDE.md`; this file covers how to carry it out without leaving the board in a state the dispatcher misreads.

## Check the split depth first

A ticket that is already a grandchild is not split again. Walk the parent chain:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){number parent{number parent{number}}}}}' \
  -f owner=pyrycode -f repo=pyrycode-relay -F num=<TICKET> \
  --jq '.data.repository.issue | "parent \(.parent.number // "none") grandparent \(.parent.parent.number // "none")"'
```

If `grandparent` is anything other than `none`, do not split. Add `needs-human:sizing`, comment with the split you would have made and why, then refine the ticket in place as one ticket. Do not wait for a person. Once splitting is off the table the only outcomes are refining it now or refining it after an interruption, so the label marks the call for later review rather than asking a question.

This is a hard gate because soft rules failed to stop recursive splitting twice. On 2026-09-01 #1925 became #1937, then #1940, then #1943 and #1944: three levels in about seventy minutes with no code written, each child's body longer than its parent's. The #1714 family did the same on 2026-08-24. The gate reads the sub-issue chain, so it goes blind unless every child is linked to its parent as below.

## Carry out a split

Each child gets a body written as if the parent never existed: full scope, full criteria and links to the docs it rests on, such as `docs/architecture.md`, the owning feature doc and the protocol spec section. Do not refer to the parent's plan or sections; each child's builder plans from its own body alone. The only ties to the parent are a `Split from #N` line at the bottom of the body and the sub-issue link.

For each child, in dependency order:

1. **Create it** with `gh issue create --repo pyrycode/pyrycode-relay --title "..." --body-file -`, passing the body on standard input so nothing is written to disk.
2. **Put it on the board in Backlog.** `gh project item-add` does not set a status, and an item with no status is invisible to every column query the dispatcher runs. Set Status to Backlog, not Inbox: the parent was already triaged.
3. **Position it right after the parent**, the first child after the parent and each later child after the previous one. Children inherit the parent's priority this way. Without an explicit position GitHub puts them anywhere, and placing the first child with no `afterId` puts it at the top of Backlog, ahead of tickets the parent was correctly behind.
4. **Link it as a sub-issue** of the parent with `addSubIssue`. The depth gate above and the dispatcher's family circuit breaker both read this chain.

Then:

5. **Set blockers between children.** When a later child consumes something an earlier one adds, mark the later one blocked by the earlier with `addBlockedBy`. The dispatcher's blocker check is the only thing that keeps them in order; concurrent dispatch can otherwise start the later child against missing code, and #41 burned money in a retry loop that way. Also chain siblings that follow the same precedent or insertion point, even when neither needs the other: both builders add their pieces in the same places, and the second conflicts on every one of them. Since 2026-09-23 the builder resolves merge conflicts, but each one costs a run and risks dropping the other side's change. Mobile #801 and #802, both told to follow the same shipped ticket's shape, collided in 16 places across six files on 2026-09-22. Merely touching the same large file is not the trigger.
6. **Re-point external dependents.** Tickets blocked by the parent will look unblocked when it closes, though what they need now lives in a child. For each open dependent, add a blocker on the child that carries what it needs, and comment: "Re-pointed from #<parent> to #<child> as part of #<parent>'s split." Leave the old parent blocker in place; the blocker check ignores closed issues.
7. **Move the parent to Done, then close it** with a comment summarising the split. The move matters: a parent left in Backlog would receive `done:refiner` and be advanced to In Development.

## Commands

Resolve every ID at runtime. Option IDs are reissued whenever the field is edited, so never hardcode them.

```bash
PROJECT_ID=$(gh project view 3 --owner pyrycode --format json --jq '.id')
FIELDS=$(gh project field-list 3 --owner pyrycode --format json)
STATUS_FIELD=$(echo "$FIELDS" | jq -r '.fields[] | select(.name=="Status") | .id')
opt() { echo "$FIELDS" | jq -r --arg n "$1" '.fields[] | select(.name=="Status") | .options[] | select(.name==$n) | .id'; }

# A ticket's project item ID and node ID
item_of() { gh api graphql -f query='query($n:Int!){repository(owner:"pyrycode",name:"pyrycode-relay"){issue(number:$n){projectItems(first:5){nodes{id}}}}}' -F n="$1" --jq '.data.repository.issue.projectItems.nodes[0].id'; }
node_of() { gh issue view "$1" --repo pyrycode/pyrycode-relay --json id -q .id; }

# Move a ticket to a column: Backlog, Inbox or Done
gh project item-edit --project-id "$PROJECT_ID" --id "$(item_of <N>)" \
  --field-id "$STATUS_FIELD" --single-select-option-id "$(opt Backlog)"

# Add a new issue to the board; prints its item ID
gh project item-add 3 --owner pyrycode --url <issue-url> --format json --jq '.id'

# Position an item after another
gh api graphql -f query='mutation($p:ID!,$i:ID!,$a:ID!){updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i,afterId:$a}){items{totalCount}}}' \
  -f p="$PROJECT_ID" -f i="<CHILD_ITEM_ID>" -f a="<PREVIOUS_ITEM_ID>"

# Link a child as a sub-issue of the parent
gh api graphql -f query='mutation($i:ID!,$s:ID!){addSubIssue(input:{issueId:$i,subIssueId:$s}){issue{number}}}' \
  -f i="$(node_of <PARENT>)" -f s="$(node_of <CHILD>)"

# Mark B blocked by A
gh api graphql -f query='mutation($i:ID!,$b:ID!){addBlockedBy(input:{issueId:$i,blockingIssueId:$b}){issue{number}}}' \
  -f i="$(node_of <B>)" -f b="$(node_of <A>)"

# Open tickets blocked by the parent
gh api graphql -f query='query($n:Int!){repository(owner:"pyrycode",name:"pyrycode-relay"){issue(number:$n){blocking(first:20){nodes{number title state}}}}}' -F n=<PARENT>
```

The snippets assume bash. Run them with `bash -c` if your shell is something else.
