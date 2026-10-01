# pyrycode-relay-agents

Agent instructions and dispatcher for [`pyrycode/pyrycode-relay`](https://github.com/pyrycode/pyrycode-relay).

Forked from [`pyrycode/agents`](https://github.com/pyrycode/agents) on 2026-05-08. As of 2026-05-09 the dispatcher source itself lives in [`pyrycode/agent-dispatcher`](https://github.com/pyrycode/agent-dispatcher) — a separate repo consumed via git submodule (see "Cloning" below). Only the relay-specific agent prompts (`architect/`, `developer/`, etc.) and `bin/` launcher scripts live in this repo.

## Layout

This repo is a sibling checkout of the target repo (`~/Workspace/Projects/pyrycode-relay-agents` next to `~/Workspace/Projects/pyrycode-relay`); the `.env` points the dispatcher at the target with `TARGET_REPO_PATH`.

```
pyrycode-relay-agents/
├── po/CLAUDE.md                # Classic set — Product Owner: ticket refinement, sizing, splitting
├── architect/CLAUDE.md         # Classic set — Architect: design specs, size enforcement
├── architect/security-review.md # Classic set — the architect's adversarial checklist
├── developer/CLAUDE.md         # Classic set — Developer: Go implementation, test-first
├── qa/CLAUDE.md                # Classic set — QA: make check + make build, baseline comparison
├── code-review/CLAUDE.md       # Classic set — Code Review: Go idiom, concurrency, security goggles
├── documentation/CLAUDE.md     # Both sets — Documentation: knowledge base, per-ticket notes, the documentation handoff
├── refiner/CLAUDE.md           # Builder set — the PO contract under its new name
├── builder/CLAUDE.md           # Builder set — plan, then implement, in one session
├── builder/security-review.md  # Builder set — the adversarial checklist on security-sensitive plans
├── verifier/CLAUDE.md          # Builder set — triage of red gates, then judgment review
├── verifier/review-criteria.md # Builder set: review criteria, shared with the preliminary reviewer
├── verifier/triage.md          # Builder set: red-gate procedure, read only when a gate fails
├── bin/                        # pyry-start, pyry-drain, pyry-status, pyry-test, ...
├── .env.example                # Copy to .env (gitignored)
└── dispatcher/                 # submodule → pyrycode/agent-dispatcher
```

## Stage sets

Two stage sets share this repo. The classic six-agent pipeline (po → architect → developer → qa → code-review → documentation) is the dispatcher's default. `PYRY_STAGE_SET=builder` in `.env` selects the four-role builder set (refiner → builder → verifier → documentation), piloted on pyrycode since 2026-09-01 and running on mobile and desktop since: the builder plans and implements in one session, and the dispatcher runs `PYRY_VERIFIER_GATES="make check;make build"` deterministically in the PR worktree before the verifier spawns. A red gate spawns the verifier in triage mode with the failure attached. Board #3 keeps its In Architecture and In QA columns; the builder set simply never polls them, so drain both columns before switching. See `.env.example` for the knobs.

Rollback is unsetting `PYRY_STAGE_SET` and restarting the dispatcher. The classic prompts stay in the tree for that and are not kept in step with the builder set.

The builder set's rework and status labels (`done:`, `needs-rework:`, `wip:` and `error:` for `refiner`, `builder` and `verifier`) already exist on `pyrycode/pyrycode-relay`.

## Cloning

```bash
git clone --recursive https://github.com/pyrycode/pyrycode-relay-agents agents
```

If you forgot `--recursive`:

```bash
cd agents && git submodule update --init
```

`bin/pyry-start` runs `pnpm install --silent` in the submodule on every restart, so submodule SHA bumps land cleanly without an extra step. To pull a newer dispatcher version:

```bash
cd dispatcher && git pull origin main && cd ..
git add dispatcher && git commit -m "chore: bump dispatcher to <sha>"
```

## Syncing agent prompts from upstream

Agent prompt fixes (e.g. an architect CLAUDE.md tweak) land in `pyrycode/agents` first; we cherry-pick the generic ones into this fork. Sync recipe (run before each session of relay-pipeline work):

```bash
cd /Users/juhanailmoniemi/Workspace/Projects/pyrycode-relay/agents
git fetch upstream main
git log --oneline HEAD..upstream/main          # see what's new in upstream
git cherry-pick <sha>                          # for each generic commit
git push origin main
```

The `upstream` remote points at `https://github.com/pyrycode/agents`. Skip pyrycode-CLI-specific commits (anything that touches `po/CLAUDE.md`'s qmd queries with `pyrycode-docs` collection, or pyrycode-flavoured architect spec patterns). Dispatcher-source commits don't need cherry-picking anymore — bump the submodule pointer instead.

If a cherry-pick conflicts on relay-specific customisations (Repo Context section in agent CLAUDE.md, README), resolve in favour of the relay version, then commit.

## Differences from `pyrycode/agents`

- Each role's `CLAUDE.md` has a "Repo Context" section noting the relay's internet-exposed, stateless, security-sensitive nature.
- Tickets default to `security-sensitive` unless they're pure-function helpers or doc updates (see PO CLAUDE.md).
- Wire protocol of record: [`pyrycode/pyrycode/docs/protocol-mobile.md`](https://github.com/pyrycode/pyrycode/blob/main/docs/protocol-mobile.md).

## Running the dispatcher

```bash
./bin/pyry-start
```

`.env` (gitignored, in this `agents/` dir) supplies the dispatcher with:

```
GITHUB_OWNER=pyrycode
GITHUB_REPO=pyrycode-relay
PROJECT_NUMBER=3
GITHUB_TOKEN=ghp_...
TARGET_REPO_PATH=/absolute/path/to/pyrycode-relay
```

`AGENTS_REPO_PATH` is exported by `bin/pyry-start` automatically.

Available `bin/` scripts:

| Script | Purpose |
|---|---|
| `pyry-start` | Start the dispatcher (foreground). |
| `pyry-drain` | SIGTERM the running dispatcher; it finishes the current dispatch then exits. |
| `pyry-restart` | Drain → wait → start. |
| `pyry-status` | Is the dispatcher running? Which Node binary? |
| `pyry-logs` | Tail dispatcher logs. |
| `pyry-test` | Run dispatcher unit tests (in submodule). |
| `pyry-typecheck` | `tsc --noEmit` (in submodule). |

`PROJECT_NUMBER=3` is the [Pyrycode-Relay](https://github.com/orgs/pyrycode/projects/3) board (created 2026-05-08). Run from a separate terminal than the pyrycode CLI dispatcher; per-repo concurrency caps via `PYRY_MAX_CONCURRENT`.
