# Relay workflow sync

Brought level with Pyrycode at `f1d1ca6` and Mobile at `b958efe` on 2026-10-03.

| Source | Relay adaptation |
| --- | --- |
| e37ade1 in Pyrycode | Shared role practice in `docs/working-practice.md`, read by the refiner, builder, verifier and documentation stage. Claude auto memory was turned off earlier the same day. |
| 97a14fe in Pyrycode | The GitHub API budget and denied-operation sections leave the role files for the shared practice. |
| 63a175e and later launcher changes in Pyrycode | `bin/pyry-start` and its tests are now identical to Pyrycode's, including the one-launch `--runner` option. |
| 46c94b6 in Pyrycode | The production-file ceiling was dropped earlier the same day, in relay PR 49. |
| fe81b64 in Mobile | Lessons fold into the feature doc for the area; per-ticket notes are frozen at 53; the documentation stage runs the false-heading and size checks itself. |
| 7fcf08c in Mobile, and its later wording | The verifier's run is one turn: run checks in the foreground and post the verdict before returning. |
| 46498dd in Mobile | The verifier finishes the whole review before deciding and reports every instance of a repeated finding. |
| c4c6f13 in Mobile | No role watches a run with the Monitor tool. |

Relay keeps its own Go and relay rules, its board, the 800-line ceiling and the pyrycode budgets. It has no live-Claude gate, no Figma work and no device tests, so Mobile's emulator, live-test and inherited lint rules do not apply. Mobile's 1600-line ceiling and larger budgets are a Mobile trial.

Relay has no approved Codex write helpers. Claude remains the default runner.

The companion product change freezes `docs/knowledge/codebase/` in `pyrycode/pyrycode-relay` and repairs the two false headings already in the feature docs. Land it before restarting the dispatcher.

The local environment sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `PYRY_AUTOCURATE_MEMORY=0` and `PYRY_FAMILY_DISPATCH_LIMIT=60`, matching Pyrycode and Mobile.
