# agents/bin/

Dispatcher operations as standalone scripts. Each is `chmod +x` and uses
`dirname "$0"` to locate the `dispatcher/` submodule relative to itself, so
they work whether invoked from `agents/`, the project root, or anywhere
else via absolute path. `pyry-start` exports `AGENTS_REPO_PATH=$AGENTS_DIR`
so the dispatcher knows where the consumer's per-agent CLAUDE.md files,
`.env`, and runtime artifacts (`logs/`, `.prompt-*.txt`) live.

## Commands

| Script | Purpose |
|---|---|
| `pyry-start` | Start the dispatcher in the foreground. Pass-through args to `pnpm`. |
| `pyry-drain` | Send SIGTERM — dispatcher finishes the current dispatch, then exits cleanly. |
| `pyry-status` | Report whether the dispatcher is running, on which Node binary, and since when. Exit 0 = running, 1 = stopped. |
| `pyry-restart` | Drain → wait for in-flight dispatch to finish (30 min cap) → start fresh. |
| `pyry-logs` | Tail dispatcher logs. `pyry-logs` (latest), `pyry-logs -a` (all), `pyry-logs <ticket>` (filter by issue number). |
| `pyry-typecheck` | Run `pnpm typecheck` in `dispatcher/` (the submodule). |
| `pyry-test` | Run `pnpm test` in `dispatcher/` (the submodule). Pass-through args. |

## Invocation

From `agents/`:
```
./bin/pyry-drain
```

From anywhere via absolute path:
```
~/Workspace/Projects/pyrycode/agents/bin/pyry-drain
```

To run by short name from anywhere, add this dir to your PATH:
```sh
export PATH="$HOME/Workspace/Projects/pyrycode/agents/bin:$PATH"
```
(Personal preference; not required for the scripts to work.)
