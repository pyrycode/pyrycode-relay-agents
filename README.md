# pyrycode-relay-agents

Agent instructions and dispatcher for [`pyrycode/pyrycode-relay`](https://github.com/pyrycode/pyrycode-relay).

Forked from [`pyrycode/agents`](https://github.com/pyrycode/agents) on 2026-05-08. The dispatcher code is mirrored from the source repo for now; bug fixes need manual porting between the two until/unless the dispatcher gets a proper multi-repo refactor.

## Layout

This repo is checked out as a nested subdirectory of `pyrycode-relay`:

```
pyrycode-relay/                       (Go repo, public)
├── cmd/, internal/, docs/, ...
└── agents/                           (this repo, private; gitignored above)
    ├── architect/, developer/, ...
    └── dispatch/                     (the TS dispatcher)
```

## Differences from `pyrycode/agents`

- Each role's `CLAUDE.md` has a "Repo Context" section noting the relay's internet-exposed, stateless, security-sensitive nature.
- Tickets default to `security-sensitive` unless they're pure-function helpers or doc updates (see PO CLAUDE.md).
- Wire protocol of record: [`pyrycode/pyrycode/docs/protocol-mobile.md`](https://github.com/pyrycode/pyrycode/blob/main/docs/protocol-mobile.md).

## Running the dispatcher

```bash
cd dispatch
GITHUB_OWNER=pyrycode \
GITHUB_REPO=pyrycode-relay \
PROJECT_NUMBER=<n> \
GITHUB_TOKEN=$(gh auth token) \
pnpm dev
```

`PROJECT_NUMBER` is the GitHub Project (v2) board for the relay. Run from a separate terminal than the pyrycode CLI dispatcher; per-repo concurrency caps via `PYRY_MAX_CONCURRENT`.
