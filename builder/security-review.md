# Security review pass — adversarial audit of your own plan

You only run this pass when the ticket carries the `security-sensitive` label. The refiner applies that label during refinement, and on `pyrycode/pyrycode-relay` most tickets carry it: the relay is internet-exposed, terminates TLS, and sits between every phone and every daemon. When it's present, the plan you just wrote needs an adversarial re-read before you commit it and start implementing. This file is the checklist and the framing; it lives in the agents repo, so read it as `$AGENTS_REPO_PATH/builder/security-review.md` — it is not inside your worktree.

## Mindset shift

You are no longer the designer. You are an adversary reviewing the plan for exploitability, with the explicit assumption that **the plan has holes**. The default verdict is FAIL until you've walked every applicable category below and found nothing.

Two failure modes to actively resist:

1. **Self-bias.** You wrote this plan ten minutes ago, and in this pipeline you are also the one about to implement it. You believe in it twice over. The whole point of this pass is to find what you missed. If your gut says "this looks fine," that's the smell — go deeper, not shallower.
2. **Coverage theatre.** Walking the checklist and writing "✓ N/A" for each category is worth nothing. For each category, either name a concrete finding — naming the symbol it lives in, or a specific scenario the plan doesn't address — or explicitly state the design decision that makes the category not applicable.

**Cite by symbol, never by line.** Findings outlive the ticket, so a `file.go:NNN` in one is stale by the time anybody reads it. This repo has no build guard for it, and `docs/threat-model.md` still anchors by `file:line`; do not copy that. Write ``the header gate in `ClientHandler` `` — resolve the name with `codegraph_search` if you need to.

**Required reading for the pass.** Two documents, and neither subsumes the other: the protocol spec's [Security model](https://github.com/pyrycode/pyrycode/blob/main/docs/protocol-mobile.md#security-model) for wire-level threats (read it with `gh api repos/pyrycode/pyrycode/contents/docs/protocol-mobile.md -H 'Accept: application/vnd.github.raw'`), and this repo's `docs/threat-model.md` for the operational surface: deploy, supply chain, DoS, log hygiene, cert handling, TLS, error leakage. `docs/security-followups.md` lists what is deliberately deferred and the trigger for each.

## Categories — walk each one

For each category, the question to answer is: *given this plan, what's the worst thing a hostile actor (or a buggy caller, or a confused developer) could trigger?*

### 1. Trust boundaries

- Where in the design does data cross from "untrusted" to "trusted"? (Network → process, file → memory, subprocess stdout → parent state.)
- Is the boundary explicit (single function, named type) or scattered (parsed in three places)?
- Who decides what "trusted" means for each boundary, and does the plan document it?
- Do downstream callers know they're now holding trusted vs untrusted data? (Type system signal? Comment? Convention?)
- **Content-blindness.** Does anything in the plan read, parse, inspect or log a payload? Inner frames must stay `json.RawMessage` end to end; structural checks happen at the envelope boundary, semantic checks belong to the daemon. A plan that looks inside a payload is a MUST FIX regardless of intent.
- Headers the relay routes on (`x-pyrycode-server`) and headers it only presence-checks (`x-pyrycode-token`): is each one checked for presence, length and shape before the upgrade, and is the token discarded after the check?

### 2. Tokens, secrets, credentials

- How are tokens generated (`crypto/rand` vs `math/rand`; sufficient entropy)?
- How are tokens stored (plaintext on disk? hashed? encrypted? what's the threat model that justifies the storage choice)?
- Where do tokens appear in logs, error messages, or stack traces?
- Token lifecycle — creation, storage, rotation, revocation, expiry. Are all four addressed?
- For revocation: is it possible? Granular (per-device) or all-or-nothing? How is revocation propagated?

### 3. File operations

- Path traversal — does any code path concatenate user input into a filesystem path without canonicalisation + boundary check?
- TOCTOU — does the plan do `os.Stat` then `os.Open` (or similar check-then-use) on a path the caller controls? If so, how does the design prevent the swap-during-the-gap attack?
- Permissions — what mode are created files? `0600` for secrets? `0700` for cert dirs? Does the plan say it explicitly?
- Symlink handling — does the design follow symlinks blindly, or does it use `O_NOFOLLOW` / equivalent for security-sensitive paths?
- Atomic writes — does the design use temp-file-plus-rename for files that could leave partial state on disk if interrupted? The relay's only on-disk state is the autocert cache (`0700` directory, refuse to start when group- or world-readable); a plan that adds any other file is itself worth a finding on why a stateless relay needs it.

### 4. Subprocess / external command execution

- Are user-controlled values passed as arguments to `exec.Command`? If so, are they validated against an allowlist or shape constraint?
- Is `sh -c` ever used (almost always wrong — it shell-interprets)?
- What environment variables are inherited vs explicitly scrubbed?
- Signal handling on the subprocess — how does the parent kill it cleanly? What about double-fork escapes?
- The relay spawns no subprocesses today. A plan that introduces one needs a justification before any of the questions above.

### 5. Cryptographic primitives

- RNG: `crypto/rand` everywhere randomness is security-relevant; `math/rand` is acceptable only for non-security uses (jitter, test fixtures).
- Primitives: pick standards (TLS via `crypto/tls`, hashing via `crypto/sha256`, key derivation via `golang.org/x/crypto/argon2` or similar). Reject hand-rolled crypto on sight.
- Key reuse — does the design accidentally use the same key/nonce for two purposes?
- Constant-time comparison — is `crypto/subtle.ConstantTimeCompare` used wherever attacker-controlled values are compared to secrets?

### 6. Network & I/O

- Input size limits — every Read from a socket needs a max-size cap. What's the cap, and is it documented in the plan?
- Header validation — for HTTP/WS upgrades, are required headers checked for presence, length, and shape before the upgrade?
- Timeout discipline — `http.Server` with explicit `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout`, `IdleTimeout`. Bare `http.ListenAndServe` is a `gosec G114` violation and a real DoS vector.
- Slow-loris resistance — does the design have a per-connection read deadline?
- Resource exhaustion — does the design cap connections per server-id? Per IP? Total? Today the upgrade paths sit behind a per-IP token bucket (`X-Forwarded-For` honoured only with `--trust-x-forwarded-for`), phones per server-id are capped, and frame reads are capped by `maxFrameBytes`; a new path must sit behind the same limits or say why not.
- Amplification — the relay forwards 1:1 today. Does the design introduce any fan-out where one inbound frame or connection produces several outbound ones, and is that bounded?
- TLS configuration — `MinVersion: tls.VersionTLS12` at minimum; cipher suite policy (Go's secure defaults are fine, but if the plan sets it explicitly, audit the choice).

### 7. Error messages, logs, telemetry

- What goes in error messages — generic for external callers, specific for internal logs?
- Do error messages leak: tokens, full headers, file paths, internal state, stack traces?
- Logs — what fields are MUST-NOT-log (payloads, full headers, tokens), what fields are MUST-log (event type, server-id, conn-id, remote host)? Every logged key must be in `internal/relay/log_allowlist.go`, which `TestLogKeysAreAllowlisted` enforces; a plan that adds a key must say why its value is safe.
- Public error bodies — does any new response write `err.Error()` or a header value to the client? Close codes and fixed strings only.
- Telemetry/metrics — do they aggregate user-identifiable data the user didn't consent to?

### 8. Concurrency

- Lock ordering — if the design takes multiple locks, is the order documented and consistent across call sites?
- TOCTOU on shared state — does the design check-then-mutate without holding a lock across both?
- Shutdown safety — what happens if the process is signalled mid-write? Mid-network-Send? Are partial states recoverable on next start?
- Goroutine lifecycle — for every goroutine the plan spawns, what causes it to exit? Is leakage possible?

### 9. Threat model alignment

- Does the design address each relevant threat in the protocol spec's § Security model?
- Does it address each relevant threat in `docs/threat-model.md`, and does it trip one of that document's "Triggers for re-review" (a new `go.mod` dependency, a new public endpoint, a changed deploy target)? A tripped trigger goes in the plan's **Documentation handoff** so the documentation stage revisits the threat model.
- Single instance — the connection registry lives in process memory and v1 is single-instance by design (`docs/architecture.md`). Does the design assume anything a second replica would break?
- If a threat is out of scope for this ticket, the plan should NAME it as out of scope and note who picks it up. A deferral already recorded in `docs/security-followups.md` can be cited by its heading.

## Decision

After walking the categories, classify each finding:

- **MUST FIX** — exploitable as designed; the plan must change before you commit it.
- **SHOULD FIX** — concerning but recoverable downstream (you add the check in Phase B; the verifier checks it landed). Note in the plan; don't gate on it.
- **OUT OF SCOPE** — explicitly deferred to a future ticket. Name the future ticket.

Verdict:
- **Any MUST FIX** → FAIL. Revise the plan to address each, then re-run this checklist from the top. Do not commit the plan yet.
- **No MUST FIX** → PASS. Append the security-review section to the plan (format below), then commit it and proceed to Phase B.

## Output format — append to the plan

Add a new section at the end of `docs/specs/architecture/{ticket}-{slug}.md`:

```markdown
## Security review

**Verdict:** PASS

**Findings:**

- [Trust boundaries] No findings — the new header is checked once, in `ClientHandler` before `websocket.Accept`; the payload stays `json.RawMessage` through `StartPhoneForwarder`.
- [Logs] SHOULD FIX — the plan logs the rejected server-id under a key not yet in `log_allowlist.go`. Add the key with its justification in Phase B; the verifier must check.
- [Network & I/O] No findings — the new listener reuses the `http.Server` timeouts set in `cmd/pyrycode-relay/main.go`.
- [Network & I/O] OUT OF SCOPE — a global live-connection cap is relay ticket #114.
- [...]

**Reviewer:** builder (self-review per the security-review checklist)
**Date:** <YYYY-MM-DD>
```

If verdict is FAIL, do NOT commit the plan yet. Revise inline, then re-run.
