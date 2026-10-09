# Pyrycode-Relay Dispatcher — Working Notes

This is the dispatcher and agent-prompts repo for **pyrycode-relay**. The Go source for the relay binary lives in the parent (`pyrycode-relay/`); this repo houses the orchestration layer that turns GitHub Project tickets into agent runs against the relay codebase.

This repo is forked from `pyrycode/agents` (see `README.md` for the upstream sync recipe). Dispatcher source itself now lives in a separate repo, [`pyrycode/agent-dispatcher`](https://github.com/pyrycode/agent-dispatcher), checked out as a `dispatcher/` git submodule (see `README.md` for the submodule install/update recipe). Agent prompts (`architect/CLAUDE.md`, `developer/CLAUDE.md`, etc.) are relay-specific (e.g. `--repo pyrycode/pyrycode-relay`, relay-context security model) and live in this repo.

## Dispatcher source layout

The dispatcher's pure-function helpers are split across five files; `lib.ts` is a thin barrel re-export.

| File | Owns |
|---|---|
| `dispatcher/src/pipeline-decisions.ts` | Auto-advance rules + decision, rework routing, done-cleanup, post-run labels, label predicates, rework-target extraction, rework-loop circuit breaker, advance-rule lookup |
| `dispatcher/src/agent-runtime.ts` | `shouldUseWorktree`, `maxTurnsFor`, salvage gating (`shouldAttemptSafeSalvage`, `findReadyPrNumber`, `extractRateLimitInfo`), `SPAWN_ENV_DENYLIST` + `scrubSpawnEnv` |
| `dispatcher/src/worktree.ts` | `shouldAutoCommit`, `decideCodegraphIndexCopy`, `decideBranchSetup`, `findWorktreesForBranch`, `resolveAgentsRepoRoot`, `resolveTargetRepoRoot` |
| `dispatcher/src/blockers.ts` | `hasOpenBlockers`, `shouldSkipBlockedFor`, `shouldProduceCommits`, `parseCommitsAhead`, `shouldFlagEmptyBranch` |
| `dispatcher/src/dispatch-selection.ts` | `AGENT_COLUMN_MAP`, `selectDispatches` |
| `dispatcher/src/lib.ts` | Barrel re-export only (kept one cycle for `dispatch.ts` + tests) |

Cross-file deps form a clean DAG: pipeline-decisions → blockers; dispatch-selection → pipeline-decisions + blockers; worktree and agent-runtime are leaves.

**New code:** prefer importing from the specific module (`from "./pipeline-decisions.js"`) over the barrel. The barrel's `export * from` lineup will likely shrink once `dispatch.ts` and tests have flipped to direct imports.

## Use codegraph for dispatcher-side reading

`pyrycode-relay/agents/` is indexed for codegraph (`.codegraph/`, gitignored). Default to the `mcp__codegraph__codegraph_explore` MCP tool for symbol-level questions before reaching for grep:

- **Before changing or removing any exported function**: run `codegraph_explore` naming it, or shell `codegraph callers <name>` for the complete list, to find the call sites across `dispatch.ts`, `reconcile.ts`, sibling lib files, and the test files. The dispatcher's pure-function decomposition means a "small" rename typically fans out to 3 to 5 sites.
- **Before extending `dispatch.ts` with a new post-run handler**: run `codegraph_explore` naming the neighbouring handlers (`decidePostRunLabels`, `runAutoAdvance`, `runReworkRouting`); their source and call paths show the shape to mirror.
- **For "where is this used / what calls what" across the dispatcher**: `codegraph_explore` with the symbols or a question about the area returns their source and the call paths between them faster than reading the files end-to-end.

The same rules apply as in agent CLAUDE.mds: use it instead of Read and grep; use grep only for string literals, comments, docs and your own new code.

**Re-index when finished:** the dispatcher gives each spawned agent's worktree its own copy of the canonical `.codegraph/` index (`decideCodegraphIndexCopy` in `worktree.ts`), which the agent's codegraph server then catches up with its branch. After a substantive change to dispatcher source, run `codegraph sync` from the repo root (1.x syncs reliably; it fails with a lock error while a codegraph server is running there, which then keeps the index current itself) so the next dispatcher run sees the new symbols.

**Querying from a different cwd (e.g. the vault):** the `codegraph_explore` MCP tool accepts a `projectPath` argument: pass `/Users/<you>/Workspace/Projects/pyrycode-relay/agents` to query the dispatcher from any session, regardless of where Claude Code was launched. Without `projectPath` the MCP server falls back to CWD, which usually isn't the project root.

## Test-first

Test-first applies to dispatcher edits as much as it does to dispatched developer agents. RED → GREEN → REFACTOR. Failing test in `lib.test.ts` (or `reconcile.test.ts`) first; implementation after. Backfilling tests after the fact ships bugs first — see PROJECT-MEMORY's "Straightforward state mutation is a smell phrase" lesson.

The dispatcher is ~1500 lines of pure functions (split across pipeline-decisions / agent-runtime / worktree / blockers / dispatch-selection) plus a thin orchestrator (`dispatch.ts`). Reading the source is cheap; theorizing without reading produces wrong answers (PROJECT-MEMORY: "Read the actual code before guessing").

## Belt-and-suspenders

Every "agent does X" rule needs a deterministic dispatcher-side safety net for X. Two stochastic rules verifying each other share the same failure mode. Recent examples in the pure-function lib + `dispatch.ts`:

- **Empty-branch guard** (`shouldFlagEmptyBranch`) — backstops architect/developer/documentation prose with a deterministic commit-count check
- **Auto-commit safety net** — backstops the agent's "remember to commit" instruction
- **`hasOpenBlockers` predicate** — backstops architect's blocker-detection prose with a deterministic GitHub query

When adding a new agent rule, ask: "what deterministic check enforces this if the agent forgets?" If there isn't one, the rule is advisory only — fine for low-cost cases, expensive for ones that ship broken work downstream.

## Shared knowledge

Read [shared development practice](docs/working-practice.md). Claude auto memory is disabled for this consumer. Keep workflow lessons in this repository and product lessons in the target repository. Do not use local memory as an additional store.
