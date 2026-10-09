# Security review pass: an adversarial audit of your own plan

Run this pass when the ticket carries the `security-sensitive` label, after writing the plan and before committing it. On `pyrycode/pyrycode-relay` most tickets carry the label, because the relay is internet-exposed, terminates TLS and sits between every phone and every daemon.

You are done when the plan ends with a `## Security review` section in the format at the bottom, with a PASS verdict and a finding for every category that applies. The verifier fails a labelled ticket whose plan has no such section.

## How to approach it

Stop being the designer and read the plan as an attacker would, assuming it has holes. You wrote it minutes ago and you are about to implement it, so you believe in it twice over. If it looks fine at first glance, look harder rather than less.

Walking the list and marking each category "not applicable" is worth nothing. For each category, either name a concrete finding, with the symbol it lives in or a scenario the plan does not handle, or state the design decision that makes the category not apply. "Nothing user-controlled flows here" is itself a finding under Trust boundaries, naming the symbol that enforces it.

Name the symbol, never the line, because findings outlive the ticket. `docs/threat-model.md` still anchors by `file:line`, so do not copy its anchors. Write ``the header gate in `ClientHandler` ``, and resolve a name with `codegraph_explore` naming the symbol, or shell `codegraph query <name>`, if you need to.

Two documents frame the threats, and neither covers the other. The protocol spec's [Security model](https://github.com/pyrycode/pyrycode/blob/main/docs/protocol-mobile.md#security-model) covers wire-level threats. Read it with `gh api repos/pyrycode/pyrycode/contents/docs/protocol-mobile.md -H 'Accept: application/vnd.github.raw'`. This repo's `docs/threat-model.md` covers the operational surface: deploy, supply chain, denial of service, log hygiene, certificate handling, TLS and error leakage. `docs/security-followups.md` lists what is deliberately deferred and the trigger for each.

## Categories

For each one, ask what the worst thing is that a hostile client, a buggy caller or a confused developer could trigger, given this plan.

### 1. Trust boundaries

- Where does data cross from untrusted to trusted, such as network to process or file to memory?
- Is each boundary explicit, in one function or a named type, or scattered across several places?
- Does the plan say what "trusted" means at each boundary, and do downstream callers know which kind of data they hold, through the type, a comment or a convention?
- **Content-blindness.** Does anything in the plan read, parse, inspect or log a payload? Inner frames stay `json.RawMessage` end to end. Structural checks happen at the envelope boundary, and semantic checks belong to the daemon. A plan that looks inside a payload is a MUST FIX whatever the intent.
- Headers the relay routes on, such as `x-pyrycode-server`, and headers it only presence-checks, such as `x-pyrycode-token`: is each checked for presence, length and shape before the upgrade, and is the token discarded after the check?

### 2. Tokens, secrets and credentials

The relay validates no tokens today, so most of this applies only when a plan adds a credential.

- Is randomness for a token from `crypto/rand`, with enough entropy?
- How is it stored, and what threat justifies that choice?
- Can it appear in logs, error messages or stack traces?
- Are creation, storage, rotation, revocation and expiry each addressed? Is revocation possible, and is it per device or all at once?

### 3. File operations

The relay's only on-disk state is the autocert cache: a `0700` directory, and the relay refuses to start when it is group- or world-readable. A plan that adds any other file is itself worth a finding on why a stateless relay needs it.

- Path traversal: does any path join caller input without canonicalising it and checking the boundary?
- Check then use: does the plan `os.Stat` then `os.Open` a path the caller controls?
- Permissions: are created files' modes explicit, such as `0600` for secrets and `0700` for certificate directories?
- Symlinks: does a sensitive path follow them blindly?
- Atomic writes: does a file that could be left half-written use a temporary file and a rename?

### 4. Subprocesses

The relay spawns no subprocesses today. A plan that introduces one needs a justification before these questions.

- Do caller-controlled values reach `exec.Command` arguments, and are they checked against an allowlist or a shape?
- Is `sh -c` used? It almost always is wrong, because the shell interprets the string.
- Which environment variables are inherited, and which are scrubbed?
- How does the parent stop the child cleanly?

### 5. Cryptography

- `crypto/rand` wherever randomness matters for security. `math/rand` only for jitter and test fixtures.
- Standard primitives: TLS through `crypto/tls`, hashing through `crypto/sha256`, key derivation through `golang.org/x/crypto/argon2` or similar. Reject hand-rolled crypto.
- Is any key or nonce used for two purposes?
- Is `crypto/subtle.ConstantTimeCompare` used wherever an attacker-controlled value is compared with a secret?

### 6. Network and I/O

- Input size: every read from a socket needs a maximum size. What is the cap, and does the plan state it?
- Header validation: for HTTP and WebSocket upgrades, are required headers checked for presence, length and shape before the upgrade?
- Timeouts: every `http.Server` sets `ReadHeaderTimeout`, `ReadTimeout`, `WriteTimeout` and `IdleTimeout`. A bare `http.ListenAndServe` is a `gosec G114` finding and a real denial-of-service risk.
- Slow clients: is there a per-connection read deadline?
- Resource exhaustion: is the new path capped per server-id, per IP and in total? Today the upgrade paths sit behind a per-IP token bucket, which honours `X-Forwarded-For` only with `--trust-x-forwarded-for`. Phones per server-id are capped, and frame reads are capped by `maxFrameBytes`. A new path sits behind the same limits, or the plan says why not.
- Amplification: the relay forwards one to one today. Does the design make one inbound frame or connection produce several outbound ones, and is that bounded?
- TLS: `MinVersion: tls.VersionTLS12` at least. Go's default cipher suites are fine, but audit any explicit choice.

### 7. Errors, logs and telemetry

- Are errors generic for external callers and specific only in internal logs?
- Can an error message leak a token, a full header, a file path, internal state or a stack trace?
- Logs must never carry payloads, full headers or tokens, and should carry the event, server-id, connection id and remote host. Every logged key must be in `internal/relay/log_allowlist.go`, which `TestLogKeysAreAllowlisted` enforces. A plan that adds a key must say why its value is safe.
- Public error bodies: does any new response write `err.Error()` or a header value to the client? Use close codes and fixed strings only.
- Do metrics collect user-identifiable data?

### 8. Concurrency

- If the design takes several locks, is the order documented and the same at every call site?
- Does it check shared state and then change it without holding a lock across both?
- What happens if the process is signalled mid-write or mid-send, and can the next start recover?
- For every goroutine the plan starts, what makes it exit? Can it leak?

### 9. Threat model alignment

- Does the design address each relevant threat in the protocol spec's Security model and in `docs/threat-model.md`?
- Does it trip one of that document's Triggers for re-review: a new `go.mod` dependency, a new public endpoint or a changed deploy target? A tripped trigger goes in the plan's Documentation handoff so the documentation stage revisits the threat model.
- The connection registry lives in process memory, and v1 is single-instance by design, per `docs/architecture.md`. Does the design assume anything a second replica would break?
- A threat out of scope for this ticket is named as out of scope, with who picks it up. A deferral already in `docs/security-followups.md` can be cited by its heading.

## Decision

Classify each finding:

- **MUST FIX:** exploitable as designed. The plan changes before you commit it.
- **SHOULD FIX:** a concern you can handle during implementation. Note it in the plan, add the check in Phase B, and the verifier checks it landed. It does not block the commit.
- **OUT OF SCOPE:** deferred on purpose. Name the ticket that picks it up.

With any MUST FIX, the verdict is FAIL. Revise the plan to address each one, then run the pass again from the top. Do not commit the plan until the verdict is PASS.

With no MUST FIX, the verdict is PASS. Append the section below to the plan, commit it, and start Phase B.

## Output format

Append this section to the end of `docs/specs/architecture/<ticket>-<slug>.md`:

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
