# Pyrycode-Relay Dispatcher — Working Notes

This is the dispatcher and agent-prompts repo for **pyrycode-relay**. The Go source for the relay binary lives in the parent (`pyrycode-relay/`); this repo houses the orchestration layer that turns GitHub Project tickets into agent runs against the relay codebase.

This repo is forked from `pyrycode/agents` (see `README.md` for the upstream sync recipe). Dispatcher source is shared with the upstream; agent prompts are relay-specific (e.g. `--repo pyrycode/pyrycode-relay`, relay-context security model). Bring upstream dispatcher fixes in via the two-PR sync pattern.

## Use codegraph for dispatcher-side reading

`pyrycode-relay/agents/` is indexed for codegraph (`.codegraph/`, gitignored). Default to `mcp__codegraph__codegraph_*` MCP tools for symbol-level questions before reaching for grep:

- **Before changing or removing any exported function in `dispatch/src/lib.ts`** — run `codegraph_callers <name>` to find the call sites in `dispatch.ts`, `reconcile.ts`, and the test files. The dispatcher's pure-function decomposition means a "small" rename in `lib.ts` typically fans out to 3–5 sites.
- **Before extending `dispatch.ts` with a new post-run handler** — run `codegraph_callees <name>` against neighbouring handlers (`decidePostRunLabels`, `runAutoAdvance`, `runReworkRouting`) to mirror their shape.
- **For "where is this used / what calls what" across the dispatcher** — `codegraph_context "<area phrase>"` returns the entry points + related symbols faster than reading the files end-to-end.

The same fall-back rules apply as in agent CLAUDE.mds: use grep/Read for comments, string literals, docs, or pending edits the canonical index doesn't yet reflect.

**Re-index when finished:** the dispatcher's worktree symlink (`decideCodegraphSymlink` in `lib.ts`) points spawned agents at the canonical `.codegraph/`. After a substantive change to dispatcher source, run `codegraph index -f` from `agents/` so the next dispatcher run sees the new symbols. (`codegraph sync` doesn't always pick up changes — confirmed 2026-05-09.)

**Querying from a different cwd (e.g. the vault):** the codegraph MCP tools accept a `projectPath` argument — pass `/Users/<you>/Workspace/Projects/pyrycode-relay/agents` to query the dispatcher from any session, regardless of where Claude Code was launched. Without `projectPath` the MCP server falls back to CWD, which usually isn't the project root.

## Test-first

Test-first applies to dispatcher edits as much as it does to dispatched developer agents. RED → GREEN → REFACTOR. Failing test in `lib.test.ts` (or `reconcile.test.ts`) first; implementation after. Backfilling tests after the fact ships bugs first — see PROJECT-MEMORY's "Straightforward state mutation is a smell phrase" lesson.

The dispatcher is < 1500 lines of pure functions plus a thin orchestrator. Reading the source is cheap; theorizing without reading produces wrong answers (PROJECT-MEMORY: "Read the actual code before guessing").

## Belt-and-suspenders

Every "agent does X" rule needs a deterministic dispatcher-side safety net for X. Two stochastic rules verifying each other share the same failure mode. Recent examples in `lib.ts` / `dispatch.ts`:

- **Empty-branch guard** (`shouldFlagEmptyBranch`) — backstops architect/developer/documentation prose with a deterministic commit-count check
- **Auto-commit safety net** — backstops the agent's "remember to commit" instruction
- **`hasOpenBlockers` predicate** — backstops architect's blocker-detection prose with a deterministic GitHub query

When adding a new agent rule, ask: "what deterministic check enforces this if the agent forgets?" If there isn't one, the rule is advisory only — fine for low-cost cases, expensive for ones that ship broken work downstream.
