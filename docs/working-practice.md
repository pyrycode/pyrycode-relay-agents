# Shared development practice

This file applies to every Pyrycode Relay pipeline role and supplements the role file. It does not grant permission to edit paths the role forbids. The pyrycode, mobile and desktop consumers keep a file of the same name, and a shared rule changed in one is ported to the others.

## Principles

- **Keep changes simple.** Touch only what the ticket needs. Do not refactor nearby code while you are there. For a non-trivial change, ask whether there is a cleaner way, but do not over-engineer routine work.
- **Fix what has been observed.** Do not add a defence for a failure that has not happened. A prose rule is cheap and mostly followed; a code check is expensive, so escalate to one only after the failure has been seen.
- **A safety net must be a different kind of check.** A rule an agent might skip is backed by deterministic code, not by a second agent rule with the same blind spot.

## Knowledge

Start from the target repository's `docs/knowledge/INDEX.md` and the feature doc that owns the ticket's area. `docs/PROJECT-MEMORY.md` holds the human-maintained conventions. The per-ticket notes under `docs/knowledge/codebase/` were frozen on 2026-10-03; read them as history, never as current instructions. Claude local memory is disabled. Do not read or write it.

Builders record durable discoveries in the PR's Lessons learned section. Verifiers record them in review comments. Refiners record them on the issue, including work that ends without a PR. Link the finding from any child that continues the work. The documentation stage folds product lessons into the owning feature doc. Workflow lessons are folded into this file or the dispatcher docs by their maintainer. Do not create a second private note.

## Sizing and planning

These apply when you size, split or plan a ticket.

Ask what the user can do differently before plumbing a descriptive identifier through the code. Do not imply capabilities the identifier does not establish.

Read a merged blocker's code and its production call sites before trusting the dependent ticket's forecast. The blocker can leave a caller unwired, or can already have completed the dependent's proof. Check for both.

Before sizing a type change, count its constructors, narrow interfaces and test doubles. Compare the nearest shipped change of the same kind, separating inserted lines from deleted ones and restricting the comparison to the new ticket's actual scope. Recalculate rather than copying old estimates, and use the current role's size limits, not thresholds from historical notes.

Dependency links and parent-child links are different. Check actual parentage for split depth. A missing parent link can hide a descendant, and several blockers do not make a root ticket a grandchild. Repair recorded lineage before using it as a gate input, then follow the current split rules.

## Issues, PRs and gates

Read security and routing labels from the issue, not the PR. Keep the two numbers apart: the PR holds the diff and comments, the issue holds the labels and the plan's identity.

The pipeline uses one GitHub identity, and GitHub refuses an author's approval or change-request review on its own PR. Post a verdict as a PR comment and apply the issue labels the role requires. Do not retry an impossible self-review.

The dispatcher owns the mechanical gates, as each role file describes. When you read a gate result, read the executed counts and the failure evidence. A one-test baseline can leave out a sibling that writes a fixture the branch's full run depends on, so compare the inputs and suite composition before blaming the change. Search existing issues before filing a new one.

## Long-running commands

Your run is one turn, and nothing resumes it when a background command finishes. Run each command in the foreground with a timeout long enough for it, and read the result before you finish. Do not watch a run with the Monitor tool: the dispatcher denies it, and the denial ends the run with `error:<agent>:permission_denied`, as it did on mobile #1311 on 2026-10-01. If a command must run in the background, read its output file with ordinary shell reads before you end the turn.

## GitHub API budget

Every dispatcher, agent and interactive session shares one GitHub account and its 5000 GraphQL points an hour. When they run out, every `gh` call in the pipeline fails until the hourly reset.

- To learn a ticket's board column, read the ticket: `gh issue view --repo pyrycode/pyrycode-relay <n> --json projectItems` costs about 2 points. Listing the board with `gh project item-list` costs about 100 points a page, and repeated listings drained the budget on 2026-09-22. List it at most once a run, and only when you need every card.
- Check the budget with `gh api graphql -f query='{rateLimit{remaining resetAt}}'`. The `gh api rate_limit` endpoint misreports this bucket.

## When an operation is denied

The pipeline is non-interactive, so a question reaches no one. When the dispatcher or Codex approval review denies an operation, such as a hard reset, a force push or a delete outside the worktree, do not try another form of it, even when it looks safe. The allowlist is the source of truth. Under Claude, send one message naming the denied operation and what you were trying to achieve, then end the turn; the dispatcher records `error:<agent>:permission_denied`, salvages what you produced and routes the ticket to the operator. Under Codex, return status blocked. A denial that came before this run needs operator review before the action is tried again. Pyrycode #398 lost its work by retrying and prompting an absent operator.

## Codex

Claude is this consumer's default runner. The launcher can select Codex for one launch, but this repository has no approved Codex write helpers yet; the pyrycode, mobile and desktop helpers are fixed to their own repositories. A Codex run's GitHub writes therefore go through approval review, and a denied write follows the section above.
