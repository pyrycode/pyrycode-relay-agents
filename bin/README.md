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
| `pyry-start` | Start the dispatcher in the foreground. Pass-through args to `pnpm`. In its terminal, Ctrl-C drains and stops; Ctrl-R drains and restarts. |
| `pyry-drain` | Send SIGTERM — dispatcher finishes the current dispatch, then exits cleanly. |
| `pyry-status` | Report whether the dispatcher is running, on which Node binary, and since when. Exit 0 = running, 1 = stopped. |
| `pyry-restart` | Drain → wait for in-flight dispatch to finish (30 min cap) → start fresh. |
| `pyry-logs` | Tail dispatcher logs. `pyry-logs` (latest), `pyry-logs -a` (all), `pyry-logs <ticket>` (filter by issue number). |
| `pyry-typecheck` | Run `pnpm typecheck` in `dispatcher/` (the submodule). |
| `pyry-test` | Run `pnpm test` in `dispatcher/` (the submodule). Pass-through args. |

## Keys in the dispatcher terminal

- **Ctrl-C** drains: the current dispatch finishes, then the dispatcher stops. A second Ctrl-C within 5 s force-quits.
- **Ctrl-R** drains, then runs `pyry-start` again from disk with the same arguments. New launcher, dispatcher and `.env` contents take effect. Ctrl-C before the drain ends cancels the restart.

A restart happens only after a clean exit. The keys work only when `pyry-start` runs in a terminal. A running dispatcher started by an older `pyry-start` needs one ordinary restart first.

## Invocation

From `agents/`:
```
./bin/pyry-drain
```

From anywhere via absolute path:
```
~/Workspace/Projects/pyrycode-relay-agents/bin/pyry-drain
```

To run by short name from anywhere, add this dir to your PATH:
```sh
export PATH="$HOME/Workspace/Projects/pyrycode-relay-agents/bin:$PATH"
```
(Personal preference; not required for the scripts to work.)

## Credential access

The launcher uses `~/.local/bin/automation-access` to load credentials through
an Automation-only 1Password service account. The helper reads the dedicated
macOS Keychain item `codex-1password-service-account`, account `automation`.
Desktop CLI integration stays disabled. The helper must replace itself with
`op` when invoked in `op` mode so launcher signals and exit status stay intact.
Set `PYRY_AUTOMATION_ACCESS` in the launching environment to use another helper path.

The local `.env` uses Automation references. Include optional credentials only when needed:

- `GITHUB_TOKEN`: `op://Automation/Pyrycode-Dispatcher-PAT/credential`
- `CLAUDE_CODE_OAUTH_TOKEN`: `op://Automation/Claude long term token/password`
- `DISCORD_WEBHOOK_URL`: `op://Automation/Discord webhook/credential`

Quote references containing spaces. Keep token values out of this file.
The service-account token is removed before the dispatcher starts.
Resolved credentials remain available for their configured uses.
All configured references are resolved at launch.
