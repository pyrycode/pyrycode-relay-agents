# Review criteria: Pyrycode Relay

These criteria are shared by the preliminary source reviewer and the final verifier. The preliminary reviewer can only read files. Anything below that needs another tool, such as codegraph, QMD, GitHub or a `go vet` run, belongs to the final verifier.

Report every finding you are confident about, with its severity. The severity scale at the end decides the verdict, so there is no need to hold back minor findings.

## Understanding the change

- **The plan** at `docs/specs/architecture/<ticket>-*.md` is the record of what this PR was meant to build. Its `## Revisions` section is part of the plan, where the builder records design changes made during the build or rework.
- **The repository's conventions** are the Project-level conventions in `docs/PROJECT-MEMORY.md`. This repo has no separate style guide. The feature doc under `docs/knowledge/features/` for each area the diff touches holds what earlier tickets learned in that area. For an internet-facing change, also read `docs/architecture.md` and the relevant sections of `docs/threat-model.md`.
- **Judge each change in the context of the code it touches.** The diff alone hides most of what matters. A changed lock or channel only makes sense against every goroutine that touches it, and a changed signature or behaviour matters at every caller. Read as much surrounding code as each change needs. Large files can be read in ranges.
- **Look past the diff for what it can break.** For each changed or removed symbol, find its callers against the pre-change shape and check the diff updates every one. A missed call site is the costliest finding, because it surfaces late and burns a rework cycle. For each new export, check whether a similar symbol already exists. Codegraph answers both quickly when it is available, and the dispatcher links the repo's index into your worktree. Fall back to grep for string literals, log messages, `t.Run` names, docs, and the builder's new code, which the index has not seen yet. A plan's list of call sites is a starting point, not the full set.
- **When the area is unfamiliar,** search QMD in `pyrycode-docs`, the daemon's docs, where the protocol spec and its security model live. There is no QMD collection for this repo. To check a wire detail directly, run `gh api repos/pyrycode/pyrycode/contents/docs/protocol-mobile.md -H 'Accept: application/vnd.github.raw'`. `docs/lessons.md` is historical, so read it only when chasing something specific and old.
- **Finish the review before deciding.** Keep checking every changed file and every applicable criterion after the first MUST FIX. When a finding reveals a repeated pattern, search the full diff for its siblings and report every instance at once. On a rework pass, check the previous findings and review the whole current diff again, not only the latest repair. Mobile #1300 took two avoidable rework laps because the first review passed two fixed corner shapes in one file and the next two reviews reported them one at a time.

## Criteria

### Go

- **Error handling.** Errors are wrapped with context using `fmt.Errorf("x: %w", err)`, none are swallowed, and matching uses `errors.Is` or `errors.As`. Protocol boundaries use `Err...` sentinel errors, wrapped with `%w` and branched with `errors.Is`, with tests in `package relay` so they can reach unexported sentinels.
- **Goroutine lifecycle.** Every goroutine has a shutdown path through a context, a done channel or a defer. None leak.
- **Context propagation.** Long-running operations take a `context.Context` and respect cancellation.
- **Defer ordering.** Deferred calls run last in, first out, so check the cleanup order. Per-connection goroutines exit through the handler's defers and do not close the connection themselves. The handler owns cleanup, and the goroutine owns only the close on its failure path.
- **Races.** Shared state is protected by a mutex or a channel. The race detector only sees the interleavings the tests reach.
- **Naming and logging.** Standard library conventions and the Project-level conventions apply. Logging uses `log/slog` with structured fields at the right level.
- **Linux-only files.** Production runs on Linux and the gates run on a Mac, so a `*_linux.go` file in the diff was never compiled by them. This is ADR-0009's split between `_<goos>.go` and `_other.go` files. The final verifier runs `GOOS=linux go vet ./...` once. That is not a gate re-run, it is the only compile the file gets, and a failure is a MUST FIX. Its Linux-only tests cannot run here, so check the PR says so.

### Relay invariants

- **Content-blind.** Inner frames stay `json.RawMessage` end to end. Any `json.Unmarshal` of a payload, any routing decision taken on a body, and any payload in a log line is a MUST FIX.
- **Log hygiene.** No payload, token or full header reaches a log call. Every logged key is in `internal/relay/log_allowlist.go`. `TestLogKeysAreAllowlisted` enforces the key set, not the value, so a key added to the allowlist needs a reason in the plan why its value is safe. A value that is safe by key and unsafe by content, such as a header dumped under an allowed key, is a MUST FIX the test cannot catch.
- **Tokens.** `x-pyrycode-token` is checked for presence and discarded. It is never validated, stored, logged or echoed. Public error bodies carry close codes and fixed strings, never `err.Error()` or a header value.
- **Bounded input.** Every new socket read has a size cap, every `http.Server` keeps its explicit timeouts, and a new upgrade path sits behind the per-IP rate limit and the existing caps unless the plan says why not.
- **Protocol fidelity.** Close codes, headers and envelope fields match `protocol-mobile.md`, and nothing appears that the spec does not define.

### General

- **Tests exist for new logic,** table-driven where that fits. The suite already ran green in the gate. What you judge is whether the tests assert the acceptance rather than merely exercise the code.
- **Plan compliance.** The implementation matches the plan including its Revisions, and the plan's open questions were resolved. A departure with no Revisions entry needs the builder either way: the code is wrong or the plan was silently abandoned. A short plan is fine for a small change. Judge it by whether the diff matches its Change paragraph and stays inside its Files read. A short plan under a diff that grew past it is a finding.
- **Plan before code.** The plan commit precedes the implementation commits. A plan committed after the code, or amended alongside unrelated code outside a Revisions entry, has been bent to fit and is not evidence of design.
- **Scope and simplicity.** The diff touches only production code and tests under `cmd/` and `internal/`, the plan file, and, when the ticket calls for them, the root build and deploy files: `go.mod`, `go.sum`, `Makefile`, `Dockerfile`, `fly.toml` and `.github/workflows/`. A doc file outside that set is a scope violation, because reference-doc changes go through the Documentation handoff. The diff does what the ticket asks and does not refactor neighbouring code along the way. A new `go.mod` dependency needs a justification in the plan. No commented-out code, no leftover debug prints, and commit messages are clear and imperative.
- **A gate-shaped concern the suite did not reach,** such as a race the tests never trigger, is a MUST FIX finding. The rework cycle sends it back through the gates.

## Security-sensitive tickets

This applies when the issue carries the `security-sensitive` label, which on this repo is most of them.

- **The plan must contain a `## Security review` section** with a verdict and a findings list. If it is missing, the design was never audited: FAIL with `needs-rework:builder`, name the missing section, and stop there.
- **Read the diff for these risks** on top of the normal criteria. Tokens or secrets reaching log lines, error messages or hex dumps. A new `os.OpenFile` without an explicit mode, `os.Stat` followed by `os.Open`, or path concatenation without canonicalisation. `exec.Command` with caller-controlled arguments, `sh -c`, or an unscrubbed environment. `math/rand` where `crypto/rand` belongs, hand-rolled crypto, or a comparison against a secret that is not constant-time. A bare `http.ListenAndServe`, a missing input-size limit, or missing header validation.
- **`gosec` and `govulncheck` are not gates here,** and this repo has no PR CI. Do not install them. Review for what they would flag instead, and treat a `// #nosec` annotation without a justification in the PR description as a finding.
- **The diff implements the plan's security findings.** If the plan said to cap the frame size before the read, check that it does.
- **Threat-model triggers.** A new dependency, a new public endpoint or a changed deploy target trips the re-review triggers in `docs/threat-model.md`. The plan's Documentation handoff must carry it.
- **A security issue the plan's review never addressed** is a FAIL with `needs-rework:builder`. Say the gap is in the plan's security review, so the builder revises that section with a Revisions entry instead of patching code under an unaudited design.

## Severity and verdict

- **MUST FIX** blocks merge. Examples: a payload read, parsed or logged, a token or header value in a log or error body, a race, a goroutine leak, a swallowed error, missing cleanup, an unbounded read, a close code or header the spec does not define, a Linux-only file that fails `GOOS=linux go vet`, a missed call site, missing tests for new logic, an undocumented departure from the plan.
- **SHOULD FIX.** Examples: naming violations, missing test cases, unclear error messages, logging at the wrong level, a duplicate of an existing pattern.
- **NIT.** Style suggestions and comment clarity.

**FAIL** on any MUST FIX, or on three or more SHOULD FIX. A PASS can carry up to two SHOULD FIX findings and any number of NITs. List them so the builder and the human see them.

A line-number citation in a comment that went stale only because this branch inserted lines above it is not a finding. At most it is a NIT, and only when the fix is a couple of digits in a file the PR already touches. Pyrycode #1458 spent three rework cycles fixing digits in code that was correct all along. This repo carries such stale citations in its older specs and in `docs/threat-model.md`, and each gets corrected when someone next edits it for a real reason. A citation the branch wrote itself is fair game, since builders are told to name symbols. This repo has no automated citation check, so a new `file.go:NNN`, range or bare `:NNN` in a comment or the plan is a SHOULD FIX naming the symbol to use instead.
