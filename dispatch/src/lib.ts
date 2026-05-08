// Pure helpers and the data the dispatcher's state machine runs on.
//
// Everything in this file is side-effect free: no I/O, no GraphQL, no
// child processes, no clock. That keeps unit tests fast and stable, and
// keeps the testable surface explicit.
//
// Anything that needs to talk to GitHub, the filesystem, claude, or git
// stays in dispatch.ts.

import { resolve } from "node:path";
import { AGENTS, type AgentConfig } from "./types.js";

// --------- Auto-advance rules ---------

export interface AdvanceRule {
  from: string;
  readyLabel: string;
  to: string;
}

// Auto-advance rules: a ticket moves from `from` → `to` when its labels
// include `readyLabel`. The chain must walk every column from Backlog to
// Done with no gaps; the consistency tests in lib.test.ts enforce this.
export const AUTO_ADVANCE_RULES: AdvanceRule[] = [
  { from: "Backlog",            readyLabel: "ready:po",             to: "In Architecture" },
  { from: "In Architecture",    readyLabel: "ready:architect",      to: "In Development" },
  { from: "In Development",     readyLabel: "ready:developer",      to: "In Code Review" },
  { from: "In Code Review",     readyLabel: "ready:code-review",    to: "In Documentation" },
  { from: "In Documentation",   readyLabel: "ready:documentation",  to: "Done" },
];

/**
 * Columns where the dispatcher does NOT auto-advance even when the
 * matching `ready:<agent>` label is present — a human reviews the work
 * and moves the ticket forward manually (same gesture as Inbox → Backlog).
 *
 * **Currently empty** (as of 2026-05-02). The architect → developer gate
 * was added 2026-05-01 as a safety net for oversized specs, then removed
 * once the size policy was enforced in code (architect either sizes ≤M
 * with a "Why M, not split" justification, or splits via `needs-rework:po`
 * — both produce a deterministic outcome that doesn't need human review).
 * The gate was duplicating safeguards.
 *
 * The mechanism stays. Adding a future gate is a deliberate policy decision:
 * append the column name here, update the corresponding test in lib.test.ts,
 * and the gating behaviour in `decideAutoAdvance` activates automatically.
 *
 * Tickets in a gated column sit with `ready:<agent>` set; the gate
 * just suppresses the auto-advance step. `shouldSkipDispatch` prevents
 * re-dispatch of an agent that has already added `ready:` for itself,
 * so the ticket is stable.
 */
export const MANUAL_ADVANCE_GATES: ReadonlySet<string> = new Set<string>();

/**
 * Columns considered "mid-pipeline" for the WIP cap. A ticket sitting in
 * any of these columns is in flight: actively progressing through agents,
 * awaiting human gate, or transiently in rework.
 *
 * Backlog and Inbox are not mid-pipeline (work hasn't started). Done is
 * not mid-pipeline (work is complete).
 *
 * Used by `runAutoAdvance` to compute available capacity for Backlog →
 * In Architecture promotions: `capacity = max(0, maxConcurrent - inFlight)`.
 * When the pipeline is at capacity, eligible Backlog tickets are held;
 * otherwise up to `capacity` of them advance per cycle, in board-position
 * order (top-of-column first).
 *
 * Tickets carrying any `error:*` label are excluded from the in-flight
 * count by the caller — they're stuck on exceptional human action and
 * shouldn't block unrelated work. Adding an `error:*` label is the
 * escape hatch for parking a normal-path ticket too (e.g. a long
 * human-gate delay where you want unrelated tickets to flow).
 */
export const MID_PIPELINE_COLUMNS: readonly string[] = [
  "In Architecture",
  "In Development",
  "In Code Review",
  "In Documentation",
];

/**
 * Count of "in flight" tickets among the given mid-pipeline items —
 * the number of pipeline threads currently consuming WIP capacity.
 *
 * Counts:
 *   - tickets actively running, awaiting human gate, or transiently in rework
 *   - tickets with no labels (just-arrived in column, awaiting dispatch)
 *
 * Excludes:
 *   - non-issue items (issueNumber <= 0, e.g. epics or draft project items)
 *   - tickets carrying any `error:*` label — those are stuck on exceptional
 *     human action and shouldn't block unrelated work. Adding `error:*` is
 *     also the escape hatch for parking a normal-path ticket (e.g. a long
 *     human-gate hold where you want unrelated tickets to flow).
 *
 * Pure function over the items the caller already collected from
 * MID_PIPELINE_COLUMNS — no I/O, no side effects, easy to unit-test.
 */
export function countPipelineInFlight(
  items: { issueNumber: number; labels: string[] }[],
): number {
  return items.filter(
    item =>
      item.issueNumber > 0 &&
      !item.labels.some(l => l.startsWith("error:")),
  ).length;
}

/**
 * True if any item in the mid-pipeline column set counts as in-flight.
 * Thin wrapper over `countPipelineInFlight`; kept as a boolean alias
 * for callers that don't need the count.
 */
export function isPipelineInFlight(
  items: { issueNumber: number; labels: string[] }[],
): boolean {
  return countPipelineInFlight(items) > 0;
}

// --------- Auto-advance decision ---------

/** Minimum item shape the decision functions need. Subset of `ProjectItem`. */
export interface DecisionItem {
  id: string;
  issueNumber: number;
  labels: string[];
  /** GitHub-native blocked-by relationships. Optional; defaults to empty
   *  (no blockers). Auto-advance excludes items with any OPEN blocker. */
  blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[];
}

/** A single column-to-column move the dispatcher will execute. */
export interface AdvanceAction {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
}

/** What `decideAutoAdvance` returns: advances + diagnostics for logging. */
export interface AutoAdvanceDecision {
  advances: AdvanceAction[];
  /** Items currently sitting at a human gate (logged as 🚦 awaiting review). */
  gatedAwaiting: { column: string; itemNumbers: number[] }[];
  /** Items in Backlog held because the pipeline is at capacity
   *  (`inFlightCount >= maxConcurrent`); logged as 🛑 held. */
  backlogHeld: number[];
}

/**
 * Pure decision function for `runAutoAdvance`. Given the rule table, gate
 * set, current items in each `from` column, the count of pipeline threads
 * currently in flight, and the concurrency cap, return the list of advances
 * to perform plus the diagnostic info the caller needs to log gate/hold
 * heartbeats.
 *
 * Semantics:
 *   - **Gated columns** (in MANUAL_ADVANCE_GATES): no advance even when
 *     `ready:<agent>` is set. Eligible items are reported in `gatedAwaiting`
 *     for heartbeat logging.
 *   - **Backlog**: capacity = `max(0, maxConcurrent - inFlightCount)`.
 *     Advance the first `min(eligible.length, capacity)` items in input
 *     order; hold the rest in `backlogHeld`. When capacity is 0, all
 *     eligible Backlog items are held. The cap matches `selectDispatches`'s
 *     concurrency model — N parallel threads through the pipeline, no
 *     PO frontrunning past available capacity. Without this cap, refined
 *     `ready:po` tickets would accumulate in Backlog while only one
 *     advanced per cycle (the pre-2026-05-08 bug).
 *   - **Mid-pipeline columns**: advance ALL eligible items. Once a ticket
 *     is past Backlog we want it to keep flowing.
 *   - An item is **eligible** when it has the rule's `readyLabel`, has a
 *     positive `issueNumber`, carries no `needs-rework:*` or `error:*`
 *     label, and has no OPEN blocker.
 *
 * Backlog input order is the user's prioritization signal — `runAutoAdvance`
 * queries with `orderBy: { field: POSITION, direction: ASC }` so top-of-column
 * comes first. Trust it; don't re-sort.
 */
export function decideAutoAdvance(
  rules: readonly AdvanceRule[],
  gates: ReadonlySet<string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
  inFlightCount: number,
  maxConcurrent: number,
): AutoAdvanceDecision {
  const advances: AdvanceAction[] = [];
  const gatedAwaiting: { column: string; itemNumbers: number[] }[] = [];
  const backlogHeld: number[] = [];

  const isEligible = (item: DecisionItem, readyLabel: string): boolean =>
    item.issueNumber > 0 &&
    item.labels.includes(readyLabel) &&
    !item.labels.some(l => l.startsWith("needs-rework:") || l.startsWith("error:")) &&
    !hasOpenBlockers(item.blockedBy ?? []);

  for (const rule of rules) {
    const all = itemsByColumn.get(rule.from) ?? [];
    const eligible = all.filter(item => isEligible(item, rule.readyLabel));

    if (gates.has(rule.from)) {
      if (eligible.length > 0) {
        gatedAwaiting.push({
          column: rule.from,
          itemNumbers: eligible.map(i => i.issueNumber),
        });
      }
      continue;
    }

    if (rule.from === "Backlog") {
      // Capacity-bounded Backlog promotion. Advance up to `capacity` items
      // in input (board-position) order; hold the rest. Capacity tracks
      // free pipeline seats so PO refinements don't pile up as `ready:po`
      // tickets that can't enter the pipeline (the bug shape: with WIP=N
      // dispatch but a hardcoded WIP=1 advance, refined backlog tickets
      // got stranded one-per-cycle while the pipeline ran serially).
      const capacity = Math.max(0, maxConcurrent - inFlightCount);
      if (capacity === 0) {
        backlogHeld.push(...eligible.map(i => i.issueNumber));
        continue;
      }
      if (eligible.length === 0) continue;
      const advancing = eligible.slice(0, capacity);
      for (const item of advancing) {
        advances.push({
          itemId: item.id,
          issueNumber: item.issueNumber,
          fromColumn: rule.from,
          toColumn: rule.to,
        });
      }
      if (eligible.length > capacity) {
        backlogHeld.push(...eligible.slice(capacity).map(i => i.issueNumber));
      }
      continue;
    }

    // Mid-pipeline: advance every eligible item.
    for (const item of eligible) {
      advances.push({
        itemId: item.id,
        issueNumber: item.issueNumber,
        fromColumn: rule.from,
        toColumn: rule.to,
      });
    }
  }

  return { advances, gatedAwaiting, backlogHeld };
}

// --------- Rework routing decision ---------

/** A single rework move + the labels the dispatcher will strip on routing. */
export interface ReworkRoute {
  itemId: string;
  issueNumber: number;
  fromColumn: string;
  toColumn: string;
  /** The needs-rework:<target> label that triggered this route. */
  triggerLabel: string;
  /** Labels to remove on routing — includes the trigger plus any
   *  ready:/wip:/error: state labels (so the target column receives a
   *  clean ticket, ready for re-dispatch). Non-state labels (size:,
   *  priority:, custom tags) are preserved. */
  labelsToStrip: string[];
}

/**
 * Pure decision function for `runReworkRouting`. Given the agent→column
 * map and current items in each column, return the list of rework routes
 * to apply.
 *
 * Per item with one or more `needs-rework:<target>` labels, the FIRST valid
 * label (by array order) wins:
 *   - Item must have `issueNumber > 0`.
 *   - Target must extract cleanly via `extractReworkTarget` (rejects bare
 *     `needs-rework:` and non-rework labels).
 *   - Target must be a known agent (in `agentColumnMap`).
 *
 * Same-column case (target column == source column) IS routed — earlier
 * versions skipped this as a "self-loop," but that left the rework label
 * on the item permanently. Combined with `shouldSkipDispatch` checking
 * for `needs-rework:<agent>` in `PIPELINE_LABEL_PREFIXES`, the label
 * persistence permanently blocked dispatch on the matching agent. The
 * fix: route same-column cases too — the caller's `updateItemStatus`
 * is a no-op for same-column updates, but the label-strip and
 * rework-count bump still happen, which unblocks dispatch. Surfaced as
 * Pyrycode #59's broader bug 2026-05-02.
 *
 * Pure function over already-collected items; the caller does the I/O
 * (status updates and label removals).
 */
export function decideReworkRoutes(
  agentColumnMap: ReadonlyMap<string, string>,
  itemsByColumn: ReadonlyMap<string, readonly DecisionItem[]>,
): ReworkRoute[] {
  const routes: ReworkRoute[] = [];

  for (const [fromColumn, items] of itemsByColumn) {
    for (const item of items) {
      if (item.issueNumber <= 0) continue;

      // First valid rework label wins. Iterate in array order for
      // determinism — same order GitHub returns from the labels query.
      for (const label of item.labels) {
        const target = extractReworkTarget(label);
        if (target === null) continue;
        const targetColumn = agentColumnMap.get(target);
        if (!targetColumn) continue;

        const labelsToStrip = [
          label,
          ...item.labels.filter(l =>
            l !== label &&
            (l.startsWith("ready:") || l.startsWith("wip:") || l.startsWith("error:")),
          ),
        ];

        routes.push({
          itemId: item.id,
          issueNumber: item.issueNumber,
          fromColumn,
          toColumn: targetColumn,
          triggerLabel: label,
          labelsToStrip,
        });
        break; // first valid rework label wins
      }
    }
  }

  return routes;
}

// --------- Done-column cleanup decision ---------

/** A single ticket's worth of pipeline-state cleanup on entering Done. */
export interface DoneCleanup {
  itemId: string;
  issueNumber: number;
  /** Pipeline-state labels to remove. Always non-empty (clean tickets
   *  produce no entry in the result array). */
  labelsToStrip: string[];
}

/**
 * Pure decision function for `runDoneCleanup`. Given the items currently
 * in the Done column, return one cleanup entry per ticket that still
 * carries pipeline-state labels.
 *
 * The bug this fixes: `runAutoAdvance` moves tickets between columns by
 * `updateItemStatus` only — it doesn't strip the `ready:<agent>` labels
 * that drove each advance. So a ticket that flowed through every agent
 * arrives in Done carrying every `ready:*` from the trail. The auto-merge
 * path strips pipeline labels, but only after `gh pr merge` succeeds —
 * doc-only tickets, manually-merged PRs, and closed-as-won't-fix never
 * get cleaned. `runClosedSweep` (which moves closed-but-not-Done tickets
 * to Done) also doesn't strip. This pass closes the gap.
 *
 * Symmetric in spirit with `decideReworkRoutes`: rework routing returns
 * `labelsToStrip` for backward column moves; this returns `labelsToStrip`
 * for the terminal column. The asymmetry between auto-advance (no strip)
 * and rework (strip) was the root cause; cleanup here re-establishes the
 * invariant that no ticket sits in a final-state column with stale
 * pipeline labels.
 *
 * Strips:
 *   - any `ready:`/`wip:`/`error:`/`needs-rework:` label (`isPipelineLabel`)
 *   - any `rework-count:N` label (counter — reset so a re-opened ticket
 *     starts fresh rather than carrying stale rounds toward the loop
 *     threshold)
 *
 * Does NOT touch:
 *   - `size:`, `priority:`, `merged`, or any free-form tag
 *   - the `merged` label specifically — its semantic is "PR was merged,"
 *     set only by the auto-merge path; reaching Done some other way
 *     shouldn't grant it
 *
 * Skips items with `issueNumber <= 0` (epics, virtual items) — same as
 * `decideReworkRoutes`. Idempotent: a clean ticket produces no entry.
 *
 * Pure function over already-collected items; the caller does the I/O
 * (label removals).
 */
export function decideDoneCleanup(
  doneItems: readonly DecisionItem[],
): DoneCleanup[] {
  const cleanups: DoneCleanup[] = [];

  for (const item of doneItems) {
    if (item.issueNumber <= 0) continue;

    const labelsToStrip = item.labels.filter(
      l => isPipelineLabel(l) || l.startsWith("rework-count:"),
    );

    if (labelsToStrip.length === 0) continue;

    cleanups.push({
      itemId: item.id,
      issueNumber: item.issueNumber,
      labelsToStrip,
    });
  }

  return cleanups;
}

// --------- Per-agent dispatch policy ---------

/**
 * True if the dispatcher should set up a git worktree for this agent and
 * push the resulting feature branch after the run. False for agents that
 * only modify external state (issues, PRs, project board) — currently
 * just PO.
 *
 * Reads `agent.usesWorktree` (declared in types.ts). The predicate exists
 * so callers grep for the policy by name and so future logic (e.g.
 * conditional behaviour by ticket type) has one place to live.
 *
 * Caught the cosmetic "feature/27 push failed: src refspec doesn't
 * match any" bug surfaced on #27: PO's run had no commits, so the
 * dispatcher's unconditional `git push` failed. Gating the push on this
 * predicate removes the spurious failure.
 */
export function shouldUseWorktree(agent: AgentConfig): boolean {
  return agent.usesWorktree;
}

/**
 * The `claude --max-turns` budget for this agent's run.
 *
 * Code review gets 100 because it dispatches sub-agents (the parent
 * turn budget covers all child invocations). Everyone else gets the
 * base budget.
 *
 * **Base budget bumped 60 → 70 on 2026-05-03 (later afternoon)** after
 * three Mode-E max_turns events in one session (#128, #75, #99) all
 * hit at exactly turn 60-61, all caught merge-ready by safer-salvage,
 * all in the housekeeping phase (commit/docs polish/PROJECT-MEMORY
 * edit/qmd re-index). Pattern: implementation + tests landed cleanly,
 * cap hit during cleanup. The salvage backstop preserved the work in
 * each case ($4.74-$6.68 each), but draft-PR-then-mark-ready is
 * higher-friction than just shipping. 10 more turns covers the
 * housekeeping tail without weakening the forcing function.
 *
 * **Earlier history:** Base budget bumped 50 → 60 on 2026-05-02
 * after #55 hit the 50 cap on an S-sized e2e ticket. Distribution
 * analysis at the time: 7+ tickets clustered exactly AT 50 turns,
 * indicating the cap was binding. Combined with the architect-spec
 * "Files to read first" rule, 60 reclaimed most of the long tail.
 *
 * Re-evaluate after ~10 dispatched runs at 70. If Mode E recurs at
 * 70-71, the right move is per-size differentiation (XS=40, S=70,
 * e2e/refactor=90) rather than another flat bump — the Mode-E cluster
 * suggests housekeeping cost is roughly fixed regardless of impl size,
 * so smaller tickets are over-budgeted at the flat rate.
 */
export function maxTurnsFor(agent: AgentConfig): number {
  if (agent.name === "code-review") return 100;
  return 70;
}

// --------- Safer max_turns salvage ---------

/**
 * True when the dispatcher should attempt the safer-salvage path on a
 * `max_turns` failure: auto-commit the agent's uncommitted work, push
 * it, open a draft PR with the agent's last messages in the body, and
 * label the ticket `error:max_turns_salvaged` for human triage.
 *
 * Distinct from the existing PR-already-exists salvage (which treats
 * max_turns + open PR as success). This fires when the agent didn't
 * get to PR creation but did produce buildable code worth preserving.
 *
 * **All four gates must pass:**
 * 1. `terminalReason === "max_turns"` — other failure shapes (api_error,
 *    timeout) don't fit the salvage pattern.
 * 2. No PR already exists — the existing salvage path handles that case.
 * 3. Working tree has changes — nothing to salvage if the worktree is
 *    clean (the agent did no productive work).
 * 4. `go vet` AND `go build` both clean — don't ship broken code as a
 *    draft PR. Failing tests are fine (they're often the signal the
 *    agent was chasing); failing vet/build means the code itself is
 *    indeterminate.
 *
 * **Why a draft PR (not a regular PR + `ready:developer`):**
 * salvaged work is by definition incomplete (the agent stopped in the
 * middle). A regular PR risks silent auto-merge of broken or partial
 * work. A draft PR + `error:max_turns_salvaged` label keeps the work
 * visible while forcing a human triage step before it advances.
 *
 * Earned its slot from four observed independent failure modes:
 * - #55 run 1: comprehension surface (mode A)
 * - #29, #40, #45: edit fan-out (mode B)
 * - #55 run 2: developer found a real production bug, thrashed trying
 *   to fix it instead of bailing (mode C)
 * - #81: OS-service polling time eats budget (mode D)
 * In all four, the developer produced real value the dispatcher
 * silently destroyed via worktree teardown. Salvage preserves it.
 *
 * Pure decision; the caller does the I/O (commit, push, gh pr create,
 * label) so this stays testable.
 */
export function shouldAttemptSafeSalvage(opts: {
  terminalReason: string;
  prAlreadyExists: boolean;
  gitStatusOutput: string;
  vetExitCode: number;
  buildExitCode: number;
}): boolean {
  if (opts.terminalReason !== "max_turns") return false;
  if (opts.prAlreadyExists) return false;
  if (opts.gitStatusOutput.trim().length === 0) return false;
  if (opts.vetExitCode !== 0) return false;
  if (opts.buildExitCode !== 0) return false;
  return true;
}

/**
 * Parse the output of `gh pr list --head <branch> --state open --json
 * number,isDraft` and return the number of the first NON-DRAFT (ready)
 * PR, or null if none exists (no PRs at all, all are drafts, or the
 * input is unparseable).
 *
 * Used by the existing PR-already-exists salvage path. That path treats
 * `max_turns + open PR exists` as success (the agent finished the work
 * and ran out of turns on cleanup). But after the safer-salvage lever
 * shipped, an open PR for a branch is often a DRAFT opened by salvage
 * itself — partial work awaiting human triage. Treating it as success
 * would auto-advance partial work via `ready:<agent>`, defeating the
 * safer-salvage design's safety property.
 *
 * Defaults to "draft" when `isDraft` is missing — the cautious default.
 * False positive (treating ready as draft) wastes a dispatch turn but
 * doesn't auto-advance broken work. False negative (treating draft as
 * ready) silently advances partial work to code-review. Cost asymmetry
 * favors the cautious default.
 */
export function findReadyPrNumber(prListJson: string): number | null {
  let prs: Array<{ number?: number; isDraft?: boolean }>;
  try {
    prs = JSON.parse(prListJson);
  } catch {
    return null;
  }
  if (!Array.isArray(prs)) return null;
  for (const pr of prs) {
    if (typeof pr.number !== "number") continue;
    if (pr.isDraft === false) return pr.number;
  }
  return null;
}

/**
 * Detect whether a thrown error is a GitHub rate-limit failure, and
 * surface the reset deadline so the caller can sleep until reset
 * instead of cascading errors for the rest of the rate-limit window.
 *
 * Returns:
 * - `null` if the error is NOT a rate-limit (caller handles normally)
 * - `{ isRateLimited: true, resetUnixSeconds: <number> | null }` if
 *   it IS a rate-limit; the unix timestamp is from the
 *   `x-ratelimit-reset` header on the failed response if Octokit
 *   surfaced it, or null if not (caller falls back to a default sleep).
 *
 * Detection is by message text — GitHub's GraphQL API returns
 * "API rate limit already exceeded" and the REST API returns "API rate
 * limit exceeded"; we match both. The reset header is informational
 * only — its presence alone doesn't indicate rate-limit state (GitHub
 * returns it on every authenticated request).
 *
 * Last night's incident: dispatcher hit the 5000 points/hour limit and
 * cascaded errors for the next ~50 minutes until reset. With this
 * detection + a sleep loop in pollLoop, the dispatcher pauses cleanly
 * and resumes on the same cycle after reset.
 */
export function extractRateLimitInfo(err: unknown): {
  isRateLimited: true;
  resetUnixSeconds: number | null;
} | null {
  // Extract the message text from Error, string, or {message} shapes.
  let message: string;
  if (err instanceof Error) message = err.message;
  else if (typeof err === "string") message = err;
  else if (err && typeof err === "object" && "message" in err && typeof (err as any).message === "string") {
    message = (err as any).message;
  } else {
    return null;
  }

  if (!message.includes("API rate limit") || !message.includes("exceeded")) {
    return null;
  }

  let resetUnixSeconds: number | null = null;
  const response = (err as any)?.response;
  const headerValue = response?.headers?.["x-ratelimit-reset"];
  if (typeof headerValue === "string") {
    const parsed = parseInt(headerValue, 10);
    if (!isNaN(parsed)) resetUnixSeconds = parsed;
  } else if (typeof headerValue === "number") {
    resetUnixSeconds = headerValue;
  }

  return { isRateLimited: true, resetUnixSeconds };
}

/**
 * Decide whether to add `ready:<agent>` after a successful agent run.
 *
 * The auto-advance step interprets `ready:<agent>` as "this agent is
 * done, move the ticket forward." But some agents legitimately move
 * the ticket OUT of their dispatch column during a successful run:
 *
 * - **PO** demotes Backlog → Inbox when a ticket lacks information
 *   for refinement (per PO's CLAUDE.md: "If a Backlog ticket lacks
 *   enough information to refine, demote it back to Inbox").
 * - **PO** moves the parent ticket Backlog → Done after a split (it's
 *   superseded by the child tickets PO created).
 *
 * In those cases, adding `ready:po` would attach a stale "ready for
 * the next stage" signal to a ticket the agent explicitly moved off
 * the pipeline. The auto-advance rule wouldn't fire (the ticket is
 * no longer in the rule's `from` column), but a human scanning the
 * board sees `ready:po` on an Inbox ticket and is misled about state.
 *
 * Rules:
 * - Rework requested → skip (existing semantics)
 * - Agent moved ticket out of its column → skip (the move IS the signal)
 * - Current column unknown (post-run fetch failed) → skip (cautious)
 * - Otherwise → add the label
 *
 * Cost asymmetry favors caution: false positive (skip when should add)
 * means one cycle of delay before the next agent dispatches; false
 * negative (add when shouldn't) creates a stale label that misleads
 * the board view.
 */
export function shouldAddReadyLabel(opts: {
  agentColumn: string;
  currentColumn: string | null;
  hasReworkTarget: boolean;
}): boolean {
  if (opts.hasReworkTarget) return false;
  if (opts.currentColumn === null) return false;
  return opts.currentColumn === opts.agentColumn;
}

// --------- Issue dependencies ---------

/**
 * True if any of the listed blockers is still OPEN.
 *
 * Uses GitHub's first-class `addBlockedBy` relationship (queryable as
 * `Issue.blockedBy` in GraphQL, visible in the issue UI as a "Blocked by
 * #N" badge). The dispatcher skips dispatch on any ticket where this
 * returns true — a blocked ticket can't make progress until its
 * dependencies close.
 *
 * Avoids the retry-loop class of failures (Pyrycode #41 hit this 6 times,
 * burning ~$4 of dev tokens, before the dev agent self-halted by
 * setting `error:developer`). Native `blockedBy` makes the constraint
 * structural — survives across runs, visible in the GitHub UI, and
 * doesn't require a custom label scheme.
 */
export function hasOpenBlockers(
  blockers: { number: number; state: "OPEN" | "CLOSED" }[],
): boolean {
  return blockers.some(b => b.state === "OPEN");
}

/**
 * True if this dispatch attempt should be skipped because the ticket
 * has any open blocker. Applies uniformly to ALL agents — including PO.
 *
 * **PO is no longer exempted (2026-05-08).** The earlier design exempted
 * PO on the rationale that refinement is "cheap prep work" — but PO
 * actually refines from the issue body PLUS the docs (`docs/PROJECT-MEMORY.md`,
 * `docs/knowledge/INDEX.md`, `docs/knowledge/features/*.md`). The
 * Documentation agent runs LAST in the pipeline, so the docs only
 * reflect a ticket's changes after that ticket auto-merges to main.
 *
 * Result of the bypass: when PO refined a blocked ticket, it read docs
 * that didn't yet describe the upstream's API / sentinels / files.
 * Refinements baked stale assumptions that either propagated into the
 * dependent's body verbatim (sometimes wrong post-merge) or produced a
 * less-grounded body that architect had to bounce back via
 * `needs-rework:po`. Net cost was throughput-negative for tight chains
 * (refactors, dependent slices), where the upstream API IS the subject
 * of the upstream ticket.
 *
 * Now: blocked tickets sit in Backlog without `ready:po` until the
 * blocker closes. PO refines once with current docs. Cycle delay is
 * one PO turn (~60s, ~$0.20-0.50) per dependency relationship — bounded
 * and deterministic.
 *
 * Auto-advance from Backlog → In Architecture also respects open
 * blockers (see `decideAutoAdvance`).
 *
 * See [[Lessons#PO refines from docs; docs lag the code; PO bypass on
 * blockers ships stale refinements (#198/#199, 2026-05-08)]] for full
 * rationale + the generalizable pattern (informational dependencies vs
 * API dependencies in any pipeline).
 */
export function shouldSkipBlockedFor(
  agentName: string,
  blockers: { number: number; state: "OPEN" | "CLOSED" }[],
): boolean {
  return hasOpenBlockers(blockers);
}

// --------- Auto-commit safety net ---------

/**
 * True if the worktree has uncommitted changes that the dispatcher should
 * auto-commit before pushing. Catches agents that wrote files but forgot
 * to commit (the bug that destroyed #27's spec via `git worktree remove
 * --force`).
 *
 * Input is the raw output of `git status --porcelain`. Whitespace-only
 * output is treated as clean — guards against false positives from
 * trailing newlines or shell padding.
 */
export function shouldAutoCommit(gitStatusOutput: string): boolean {
  return gitStatusOutput.trim().length > 0;
}

// Built from AGENTS — single source of truth for the name → column mapping.
export const AGENT_COLUMN_MAP: ReadonlyMap<string, string> = new Map(
  AGENTS.map((a: AgentConfig) => [a.name, a.column]),
);

// --------- Dispatch candidate selection ---------

/** A single (agent, item) pair the dispatcher will run this cycle. */
export interface DispatchCandidate<T extends DecisionItem = DecisionItem> {
  agent: AgentConfig;
  item: T;
}

/**
 * Pick which (agent, item) tuples to dispatch this cycle, up to `maxConcurrent`.
 *
 * Iterates `pollOrder` (most-advanced-first) and within each agent's column
 * scans items in order, accumulating eligible dispatches. Eligibility is the
 * same per-item gate the original WIP=1 loop applied — `shouldSkipDispatch`
 * (label-based: ready/needs-rework/wip/error/error:max_turns_salvaged) AND
 * `shouldSkipBlockedFor` (open-blocker-based, applies to all agents
 * including PO — see that function's docstring for the docs-lag rationale).
 *
 * Concurrency model: WIP=1 *per dependency chain*, parallel across chains.
 * Two unrelated tickets (neither blocks the other) can run simultaneously.
 * Two tickets where A blocks B are kept serial because while A's wip:<agent>
 * is set, A's issue stays OPEN, and B's blockedBy(A) gates it through
 * `shouldSkipBlockedFor`. So this function never picks both halves of an
 * in-flight blocker pair, even when iterating an outdated snapshot.
 *
 * Multiple eligible items in the same column produce multiple candidates for
 * the same agent — two PO instances can refine two unrelated Backlog tickets
 * in parallel. The cap is the `maxConcurrent` budget, not per-agent.
 *
 * Pure function over a snapshot. Caller is responsible for invalidating the
 * snapshot (per-cycle items cache) at appropriate boundaries.
 */
export function selectDispatches<T extends DecisionItem>(opts: {
  itemsByColumn: ReadonlyMap<string, readonly T[]>;
  pollOrder: readonly AgentConfig[];
  maxConcurrent: number;
}): DispatchCandidate<T>[] {
  const { itemsByColumn, pollOrder, maxConcurrent } = opts;
  const out: DispatchCandidate<T>[] = [];
  if (maxConcurrent <= 0) return out;
  for (const agent of pollOrder) {
    if (out.length >= maxConcurrent) break;
    const items = itemsByColumn.get(agent.column) ?? [];
    for (const item of items) {
      if (out.length >= maxConcurrent) break;
      if (shouldSkipDispatch(item.labels, agent.name)) continue;
      if (item.issueNumber > 0 && shouldSkipBlockedFor(agent.name, item.blockedBy ?? [])) continue;
      out.push({ agent, item });
    }
  }
  return out;
}

// --------- Worktree branch setup ---------

/**
 * Decide what to do with a feature branch before creating its worktree.
 *
 * The dispatcher's earlier behaviour was: if the local ref already exists
 * (from a prior dispatch), reuse it AS-IS. That breaks when someone pushes
 * to `origin/<branch>` out-of-band between dispatches (e.g., manual triage
 * worktree, hot-fix). Local stayed stale, worktree got the old commit, the
 * agent ran on out-of-date code. Surfaced 2026-05-07 (#155 code-review).
 *
 * Origin is the source of truth: if local is behind, fast-forward; if
 * local has commits not in origin, that's an integrity error (a prior
 * dispatch failed to push and we never noticed) and requires human triage.
 */
export type BranchSetupAction =
  /** Neither local nor remote exists. Create local from `main`. */
  | "create-from-main"
  /** Only remote exists. Create local from `origin/<branch>`. */
  | "create-from-origin"
  /** Local exists but no remote. Reuse local; first push will create origin. */
  | "reuse-local-no-remote"
  /** Both exist and local SHA == origin SHA. Reuse local (no-op sync). */
  | "reuse-local-already-synced"
  /** Both exist; local is a strict ancestor of origin. Fast-forward local. */
  | "fast-forward-from-origin"
  /** Both exist; local has commits not in origin (or diverged). Abort. */
  | "abort-local-ahead-of-origin";

export function decideBranchSetup(opts: {
  localExists: boolean;
  remoteExists: boolean;
  /** True iff local SHA equals origin SHA. Required when both exist. */
  localEqualsOrigin?: boolean;
  /** True iff local is a strict ancestor of origin (fast-forwardable).
   *  Required when both exist and SHAs differ. */
  localIsAncestorOfOrigin?: boolean;
}): BranchSetupAction {
  if (!opts.localExists && !opts.remoteExists) return "create-from-main";
  if (!opts.localExists) return "create-from-origin";
  if (!opts.remoteExists) return "reuse-local-no-remote";
  if (opts.localEqualsOrigin) return "reuse-local-already-synced";
  if (opts.localIsAncestorOfOrigin) return "fast-forward-from-origin";
  return "abort-local-ahead-of-origin";
}

// --------- Spawn env hygiene ---------

/**
 * Environment variables that MUST NOT be passed to spawned `claude`
 * processes. These are dispatcher secrets and config; the spawned agent
 * doesn't need them and shouldn't see them.
 *
 * `GITHUB_TOKEN` is the canonical leak case — `claude` uses `gh`'s own
 * credential store (or `git credential helper`) for repo access; the
 * dispatcher's token would only enable the agent to act with the
 * dispatcher's identity (different scope, surprises in audit logs, and
 * bypasses any per-agent token rotation later).
 *
 * Denylist over allowlist deliberately: `claude` relies on a wide set of
 * env vars (PATH, HOME, LANG, LC_*, TMPDIR, NODE_*, ANTHROPIC_*, …) and
 * an allowlist would silently break new dependencies. A small denylist
 * keeps the secret-leak surface bounded without reducing flexibility.
 */
export const SPAWN_ENV_DENYLIST: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "PROJECT_NUMBER",
  "DISCORD_WEBHOOK_URL",
  "PYRY_MAX_CONCURRENT",
  "PYRYCODE_REPO_PATH",
]);

/**
 * Filter dispatcher secrets/config out of an env map before spawning a
 * child agent. Returns a fresh object — does not mutate the input.
 */
export function scrubSpawnEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (SPAWN_ENV_DENYLIST.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// --------- Worktree introspection ---------

/**
 * Parse `git worktree list --porcelain` output and return the worktree
 * directories (if any) currently checked out at the given branch.
 *
 * `git worktree add <path> <branch>` fails with "fatal: '<branch>' is already
 * checked out at '<other-path>'" when the branch is in use elsewhere — even
 * if `<path>` is fresh. The dispatcher's stale-worktree cleanup at the start
 * of `dispatchToAgent` only handles the same-path case (`worktreeDir`); it
 * misses orphan worktrees on the same branch under different paths (a prior
 * cycle's `architect-100` left over when this cycle wants `developer-100`).
 *
 * Surfaced 2026-05-08 review (#5). The orphan blocks all future dispatches
 * on the affected branch with `error:<agent>`, indefinitely, until a human
 * runs `git worktree remove --force` by hand.
 *
 * Porcelain format (one record per worktree, blank-line separated):
 *
 *     worktree /path/to/wt
 *     HEAD <sha>
 *     branch refs/heads/<branch>
 *
 * Detached HEADs surface as `detached` (no `branch` line). Bare repos as
 * `bare`. Either way we don't match (no branch to compare).
 *
 * Pure function over the porcelain string; no I/O. Tests in lib.test.ts.
 */
export function findWorktreesForBranch(
  porcelainOutput: string,
  branchName: string,
): string[] {
  const target = `refs/heads/${branchName}`;
  const out: string[] = [];
  let currentPath: string | null = null;
  for (const rawLine of porcelainOutput.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") {
      currentPath = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ") && currentPath !== null) {
      const branchRef = line.slice("branch ".length);
      if (branchRef === target) out.push(currentPath);
    }
  }
  return out;
}

// --------- Path resolution ---------

/**
 * Resolve the agents repo root from a source-file directory.
 *
 * The dispatch source lives at `agents/dispatch/src/`, so `../..` takes us
 * to `agents/`. Anything more would escape into the parent (the
 * `pyrycode/` Go repo) — which is what the original buggy version did
 * with `"../../.."` (commit `c72adb4` fixed it).
 */
export function resolveAgentsRepoRoot(srcDir: string): string {
  return resolve(srcDir, "../..");
}

/**
 * Resolve the pyrycode Go repo root from the agents repo root.
 *
 * `agents/` lives **inside** `pyrycode/` (gitignored there) rather than
 * as a sibling, so the pyrycode root is just the parent of agents/.
 *
 * The original code had `agentsRepoRoot + "../pyrycode"`, which silently
 * "worked" only because `agentsRepoRoot` was *also* buggy and pointed at
 * the pyrycode root. Once that bug was fixed, this one surfaced — first
 * dispatcher run after the fix tried `pyrycode/pyrycode/` and ENOENT'd.
 */
export function resolvePyrycodeRepoRoot(agentsRepoRoot: string): string {
  return resolve(agentsRepoRoot, "..");
}

// --------- Label predicates ---------

// The four label prefixes the dispatcher uses for per-agent state.
//   ready:<agent>        — agent completed successfully
//   needs-rework:<agent> — agent (or another) flagged the ticket back here
//   wip:<agent>          — agent currently running
//   error:<agent>        — agent crashed
export const PIPELINE_LABEL_PREFIXES = [
  "ready:",
  "needs-rework:",
  "wip:",
  "error:",
] as const;

/**
 * True if the given label is one of the dispatcher's pipeline-state labels.
 * Used for stripping stale labels before re-dispatching an agent.
 */
export function isPipelineLabel(label: string): boolean {
  return PIPELINE_LABEL_PREFIXES.some((p) => label.startsWith(p));
}

/**
 * True if the given label is a pipeline-state label for the given agent
 * specifically (e.g. `error:developer` is for `developer`, not for any
 * other agent).
 *
 * The pre-dispatch strip loop uses this to scope cleanup to labels for the
 * agent we're about to run — without it, dispatching `architect` would
 * silently strip a `error:developer` that a prior dev run left as a
 * human-actionable signal. The pattern surfaced in the 2026-05-08 review
 * (#9): "labels are the truth" cuts both ways — stripping another agent's
 * signal IS a state mutation that the agent never authorized.
 *
 * shouldSkipDispatch already blocks the candidate when the SAME agent's
 * label is present, so the strip is purely defensive against state-drift
 * (e.g. label arrived between candidate selection and dispatch). Scoping
 * to the agent's own labels means the strip can't accidentally erase
 * another agent's state.
 */
export function isPipelineLabelForAgent(label: string, agentName: string): boolean {
  return PIPELINE_LABEL_PREFIXES.some((p) => label === p + agentName);
}

/**
 * Pipeline labels that block dispatch for ALL agents (not scoped to a
 * specific agent's name). Until any of these is stripped, no agent should
 * re-run on the ticket.
 *
 * - `error:max_turns_salvaged` — ticket's salvaged work sits in a draft PR
 *   awaiting human triage. Without the block, the next dispatch's existing
 *   PR-salvage path (which treats max_turns + open PR as success) would
 *   auto-advance partial work via `ready:<agent>`. See `attemptSaferSalvage`
 *   and `shouldAttemptSafeSalvage` for the salvage flow.
 * - `error:merge-conflict` — auto-merge against `main` failed because the
 *   PR has a merge conflict. The label stops the auto-merge retry loop
 *   (which would otherwise hammer `gh pr merge` every cycle for zero
 *   progress, burning GraphQL points). The dispatcher's auto-merge block
 *   skips tickets carrying this label; the human resolves the conflict
 *   manually (`gh pr checkout … && git merge origin/main && …`) and strips
 *   the label to resume. Mirrors `error:max_turns_salvaged` shape: preserve
 *   work, force human attention, stop the loop. Detection uses
 *   `isMergeConflictError` on the gh CLI's stderr.
 */
export const GLOBAL_BLOCK_LABELS: ReadonlySet<string> = new Set([
  "error:max_turns_salvaged",
  "error:merge-conflict",
]);

/**
 * True if the given subprocess stderr/error indicates `gh pr merge` failed
 * because the PR has a merge conflict against its base. Matches the two
 * canonical phrases gh CLI emits ("is not mergeable" / "merge commit cannot
 * be cleanly created") plus the lower-case "merge conflict" phrase older
 * gh versions and other tooling use. Case-insensitive — gh's wording has
 * shifted across versions.
 *
 * Used by the dispatcher's auto-merge loop on Done tickets: if a merge
 * attempt errors and `isMergeConflictError(stderr) === true`, the
 * dispatcher labels the ticket `error:merge-conflict` (a global block),
 * posts a triage comment with the resolution recipe, and stops retrying.
 * Returns `false` for empty / undefined input — caller decides whether
 * "no stderr" means "no error" (skip) or "unknown failure" (also skip).
 */
export function isMergeConflictError(stderr: string | null | undefined): boolean {
  if (!stderr) return false;
  const s = stderr.toLowerCase();
  return (
    s.includes("not mergeable") ||
    s.includes("merge commit cannot be cleanly created") ||
    s.includes("merge conflict")
  );
}

/**
 * The four-label gate from pollLoop's per-ticket inner loop: a ticket
 * should be skipped from dispatch if any of `ready:<agent>`,
 * `needs-rework:<agent>`, `wip:<agent>`, or `error:<agent>` is present.
 *
 * Returns true to skip (don't dispatch this agent on this ticket).
 * Returns false otherwise (proceed with dispatch).
 *
 * Per-agent labels: OTHER agents' labels do NOT cause a skip — only
 * labels scoped to the agent currently being considered.
 *
 * Global-block labels (`GLOBAL_BLOCK_LABELS`) skip ALL agents until a
 * human strips them. Currently just `error:max_turns_salvaged`.
 */
export function shouldSkipDispatch(labels: string[], agentName: string): boolean {
  if (labels.some((l) => GLOBAL_BLOCK_LABELS.has(l))) return true;
  return PIPELINE_LABEL_PREFIXES.some((p) => labels.includes(p + agentName));
}

// --------- Rework target extraction ---------

/**
 * Parse a `needs-rework:<agent>` label and return the target agent name.
 * Returns null for labels that don't have the prefix or have an empty
 * target (the latter is an unusual but defensible input — e.g. someone
 * typed `needs-rework:` without a target).
 */
export function extractReworkTarget(label: string): string | null {
  const prefix = "needs-rework:";
  if (!label.startsWith(prefix)) return null;
  const target = label.slice(prefix.length);
  return target.length > 0 ? target : null;
}

// --------- Rework loop circuit-breaker ---------

/**
 * Number of rework rounds a single ticket can absorb before the dispatcher
 * halts dispatch and adds `error:rework-loop`. Adjusting this is a
 * deliberate policy change — see the test in lib.test.ts that locks the
 * default to 3.
 *
 * Why 3: the typical legitimate rework cycle is one round (agent finds
 * issue, routes back, fix lands, advances). A second round means the
 * fix wasn't right. A third round is unusual but defensible. A fourth
 * round is the loop pattern Pyrycode #41 hit (6 dispatches, ~$4
 * burned, dev agent self-halted by intelligence rather than structure).
 * Halting at 3 catches genuine loops well before they accumulate cost.
 */
export const REWORK_LOOP_THRESHOLD = 3;

/**
 * Read the current rework count from a ticket's labels. Looks for any
 * `rework-count:N` label and returns the maximum value found (or 0 if
 * none present). Multiple count labels shouldn't occur in normal
 * operation, but if they do, the maximum is the safest read — biases
 * toward halting rather than under-counting.
 *
 * Tolerates malformed labels (`rework-count:abc`, `rework-count:`) by
 * treating them as 0. Negative values are treated as invalid.
 */
export function extractReworkCount(labels: string[]): number {
  const prefix = "rework-count:";
  let max = 0;
  for (const label of labels) {
    if (!label.startsWith(prefix)) continue;
    const tail = label.slice(prefix.length);
    if (tail.length === 0) continue;
    const n = parseInt(tail, 10);
    if (isNaN(n) || n < 0) continue;
    if (n > max) max = n;
  }
  return max;
}

// --------- Auto-advance rule lookup ---------

/**
 * Find the auto-advance rule that applies given the ticket's current
 * column and labels. Returns null if no rule matches.
 */
export function findAdvanceRule(
  rules: AdvanceRule[],
  fromColumn: string,
  labels: string[],
): AdvanceRule | null {
  return rules.find((r) => r.from === fromColumn && labels.includes(r.readyLabel)) ?? null;
}

