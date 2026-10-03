# Sizing evidence: Pyrycode Relay refiner

The measurements behind the sizing rules in `CLAUDE.md`. Read this only when you doubt a number, or when someone asks for the numbers to be re-measured. Ticket numbers without a repo name are `pyrycode/pyrycode` tickets.

## Where the line ceiling comes from

The ceilings were recalibrated to the builder's budget on 2026-09-02, on pyrycode, and adopted here without relay builder runs behind them. This repo's six-agent PO split at 150 production lines and 3 files, and its architect at about 600 lines of total written work.

For scale, the relay's 30 feature, fix and CI PRs merged from 2026-05-11 to 2026-09-16 added between about 130 and 1350 lines each, spec and knowledge doc included, with a median near 470. The one that exhausted its budget was the 21-file WebSocket-library migration, relay PR #102: a call-site cascade, not a line count.

The older 400-line, 3-file table was set for a developer with 135 turns and 25 minutes. The builder has 200 turns and 40 minutes for plan plus implementation. Across its first 21 runs on pyrycode, 2026-09-01 to 02, no run exhausted either: the median used 60 turns and 14 minutes, the heaviest 127 turns (#1826) and 23 minutes (#1825). The median merged PR in that sample added about 920 lines including spec and docs, so most tickets already landed above the old ceiling and inside a third of the budget. 800 lines sits inside a two-times margin of the heaviest run.

A five-file ceiling on production source files was dropped on 2026-10-03, on every board. File count measured how a change is wired, not how much work it is: one new desktop event type forces a one-line case in about eight files. It did not bound the tail either. Desktop #1249, estimated at 1300 lines over 12 files, built inside the budget.

Line count predicts turns weakly. #1979 landed 964 added lines in 34 turns and #1826 landed 1005 in 127. The ceiling bounds the tail rather than sizing the typical ticket, and the call-site and reject-branch lines bind regardless of line count.

**Re-measure after ten more builder runs before moving the number.** Read turns and duration from the `USAGE` block at the end of each builder log, and grep the logs for `Resume leg`. A run that exhausts a second leg is the first real evidence for tightening. Do not tighten from memory of the old set.

## Why total written work, not production lines

On 2026-05-16 three specs sized by production lines alone came in at 541, 596 and 1071 actual lines, and all three needed salvage. Tests, helpers and per-branch log calls were three to five times the production count.

## Why there is no larger tier

Earlier versions allowed an M tier with a "Sized M because" paragraph. It was removed on 2026-05-02 after #45, sized M with five files of cross-package coordination and ten criteria, exhausted the implementation budget and needed recovery. The six-agent relay's design stage carried the same "why M, not split" escape, and it went the same way.

## Why the floor exists, and why it beats the ceiling

On the #1720 split, 2026-09-02, four one-consumer pairs were cut apart to stay under the old 400-line ceiling: map then bound, retain then resolve, reconcile then wire, and a docs-only tail. Ten tickets carried what five would have. The first three children still measured over the ceiling and shipped at a third of the builder's budget.

On 2026-09-01 the #1925 family used five tickets to commit one captured file, each carrying four or five criteria against a ceiling of five. It had spent $213 by mid-morning and was projected near $330, for recording the shape of a single tool call.

## Why criteria are trimmed, not split for their count

On 2026-08-24 the #1714 family became #1728 and #1729, then #1728 became #1730 and #1731, then #1730 became #1732 and #1733. Three rounds of splitting in one morning, none prompted by anything learned from writing code. Each child's body was longer than its parent's, 3940 characters to 10531 to 18683, and all seven tickets carried exactly five criteria. A limit that binds on every ticket regardless of size is being used as a template.

On 2026-09-07 eighteen tickets sat in the two pilot Backlogs at six to nine criteria because the filer had filled them. Splitting those would have paid a refiner pass and a builder leg per child for no work gained.

## Why body length is cut

Measured 2026-09-07 on pyrycode-desktop: sixty tickets filed by hand in one week ran from 1400 to 15000 characters, and the length tracked how much the filer had read, not the work. #1113, four CSS declarations, arrived at 9700 characters ordering a new proof pair, seven comment rewrites and a docs fold.

## Why symbols, not line numbers

Measured 2026-09-07 on pyrycode's board: 45 of the 60 open tickets carried line citations, 311 in all, and every one audited had drifted. Upstream, a spec carrying dozens of citations produced a developer that wrote 71 of its own (#1417).

## What a split costs against a budget miss

Measured 2026-09-02 from the run logs of #2001 and #2002 on pyrycode's builder set. This fork had no builder runs to measure then; the shape is what carries.

| Outcome | Measured cost |
|---|---|
| One ticket through refiner, builder, verifier and documentation, clean | ~$15 |
| The builder leg alone | ~$7-8 |
| Extra cost of one more split | ~$15, plus a refiner pass on each child |
| Extra cost of a budget miss that resumes | ~one builder leg |

Until 2026-09-02 the guide leaned towards splitting, because a run that exhausted its budget was salvaged into a draft PR labelled `error:max_turns_salvaged` and parked for a person. Resume-in-place has been live since 2026-09-01, so a miss now costs a leg rather than an interruption. #29 and #40, the two exhaustions the old default cited, both ran before any resume existed. The figures this table replaced, measured on the six-agent relay set on 2026-09-01 across 88 tickets, were about $32 per clean ticket, $16 per rework pass and $32 per extra split. The shape was the same; only the parked ticket made splitting the safer side.

## The shared test infrastructure split

#860 and #861 were split by hand at triage after the bundled versions parked at the developer watchdog. pyrycode-mobile #527 and pyrycode-desktop #421 and #420 were split at filing time, and their tickets rode them cleanly. The rule ticket is pyrycode-agents #32.
