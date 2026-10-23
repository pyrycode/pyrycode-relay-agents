# Builder scope reassessment

Check scope before planning, before committing the plan, whenever implementation reveals substantial additional work, and at the start of every repair. Compare completed plus remaining production work, tests, shared helpers and migrations against the admitted estimate and the role's boundaries. Do not wait for the budget to run out or for two failed reviews.

New independently useful behaviours or a materially larger migration require reassessment. A further attempt to fix the same defect normally stays in the ticket. Preserve the defect's regression. File count alone, a long description, a small estimate correction or a failing test alone does not justify splitting.

## Stop expansion and preserve work

Stop adding scope. Keep existing commits, partial files, branches, pull requests, plans and failed evidence. Never reset, discard or delete work to make a handoff look like a fresh planning run. Do not mark unfinished work complete. Do not create or close split children from the builder run.

Write a self-contained assessment with:

- The original estimate and the new estimate, separating completed and remaining work.
- The inspected source revision and concrete newly discovered consumers or behaviours.
- Existing branch, commit, pull request, local worktree and test-evidence references.
- Proposed parts with an independently useful result, meaningful checks and dependency order for each.
- Where each original requirement and unresolved review finding would go. Preserve security review, required live acceptance and documentation.

For a broad migration, check whether existing consumers can adopt the supported contract in passing groups before the final enforcement change. Do not split a bug from its regression or create unused helpers just to reduce a line count. If no safe split is known, explain why and request assessment rather than inventing one or expanding automatically.

## Request orchestrator assessment

On Codex, return `needs_scope_review` with that assessment in the summary. Do not post the routing comment or label yourself. On Claude, post the assessment, add `error:builder:scope` through the managed workflow bridge, and end the run. This is a scope request, not a claim that product code failed. The dispatcher retains the worktree without auto-committing, pushing or declaring completion. A comment without the outcome or label does not request assessment.

The orchestrator assesses after the builder ends. It verifies retained builder evidence and performs any justified split with the existing protected recovery transaction. A discovered-scope split does not need prior verifier failures. A later repair may still use the ordinary repeated-rework route. Both preserve ownership, holds, dependencies, failed evidence and complete child acceptance. Missing evidence remains pending.

An ordinary refiner's split-depth limit does not require a builder to continue oversized work. The rule keeping one-use helpers with their consumer prevents useless children; it does not authorise unlimited growth. Request assessment at any depth. Recovery may exceed the ordinary depth limit when the evidence establishes smaller independently testable results. It must not repeatedly split unchanged scope. If the evidence instead supports one bounded repair, recovery returns that concrete plan to the builder.

A permission rejection, missing access, infrastructure failure or flaky check keeps its existing route. A scope request cannot override an operator hold or approval decision.
