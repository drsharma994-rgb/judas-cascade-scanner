# Tradelog A/B Reconcile — Handoff

Fixed the Outcome Lab's structural-vs-fixed A/B so it actually measures two
different plans instead of comparing a target against a near-copy of itself.
All changes are in **`tradelog.js` only**. No endpoint response shapes changed
(the UI-consumed keys are all preserved; one additive `paired_n` was added).
Safety unchanged: pure data, no orders, no private account access, public Delta only.

## The bug it fixes

Previously the A/B was meaningless:
- `logSetup` never recorded `tpStruct`/`rrStruct`, so the structural plan was
  unavailable at resolve time.
- `resolveOpen` measured "structural" against `rec.target` (the *fixed* target)
  and recomputed "fixed" as `entry ± fixed_rr·risk` — so both legs were
  essentially the fixed plan. Closure was gated by that mislabeled "structural"
  leg.
- `structural_minus_fixed_R` subtracted two means taken over *different* samples,
  and win rate was computed from the structural leg.

## Changes (`tradelog.js`)

1. **`numOrNull(x)` helper** — coerces to a finite number or `null`, guarding the
   `+null === 0` trap so a missing `tpStruct` never becomes a bogus `0` price.

2. **`logSetup`** now records `tpStruct: numOrNull(r.tpStruct)` and
   `rrStruct: numOrNull(r.rrStruct)` on each OPEN event. Missing structural
   target stays `null`.

3. **`resolveOpen`** — corrected A/B semantics:
   - **Fixed (actually-traded) plan** = `tripleBarrier(side, entry, stop,
     rec.target, …)` → `fixedOutcome` / `fixedR`. **This plan gates closure.**
   - **Structural counterfactual** = measured against `rec.tpStruct` *only when
     present*; otherwise `{outcome:null, R:null}`. Stored as top-level
     `outcome` / `R`.
   - A record closes when the **fixed** plan hits TP/SL or time-stops with a full
     forward window — never on the structural leg.

4. **`summarize` / `expectancy`**:
   - `structural_minus_fixed_R` is now the **mean of paired per-record diffs**
     (`R - fixedR`) over records where **both** exist — not a difference of two
     independent means. Added `paired_n` (count of paired records).
   - `win_rate` now reflects the **actual fixed plan** (`fixedR > 0`), still
     suppressed below `min_n` with `win_rate_provisional` available.
   - `tripleBarrier` tie-break unchanged: same-candle SL+TP → **SL** (pessimistic);
     round-trip taker fee + slippage subtracted in R.

(No changes to `scanner.js`, `server.js`, `app.js`, `index.html`, `sw.js`.
`scanner.js` already emits `tpFixed`, `rrFixed`, `tpStruct`, `rrStruct`,
`targetMode`, `entryTime`, `entryTf` plus retries/backoff and confirmatory/
regime/bias fields — left intact. No new dependencies.)

## Verification

- `npm run check` → **PASSED** (server.js, scanner.js, app.js, tradelog.js).
- Direct node A/B tests (`/tmp/ab_test.js`) → **9/9 PASSED**:
  - same-candle SL/TP tie resolves **SL**;
  - `logSetup` keeps `null` `tpStruct` as `null` (and preserves a numeric one);
  - `resolveOpen` closes via the **fixed** plan even when `tpStruct` is null
    (CLOSE has finite `fixedR`/`fixedOutcome`, structural `R`=null);
  - `structural_minus_fixed_R` uses **paired** records only (0.75, not the naive
    0.933), structural expectancy over the structural sample (1.5), win rate from
    the fixed plan.
- Live smoke test (`PORT=8011 node server.js`): `/api/health` → **200**;
  `/api/tradelog/expectancy` → **200**; `/api/log` (alias) → **200**. Response
  shape intact (all UI keys present). Test `data/` removed; port freed.

## Redeploy / publish

- Backend logic change only. **Restart `node server.js` / `npm start`** to load it.
- **No service-worker bump needed** (no client UI/asset change).
- Parent should **redeploy/restart the backend** to pick up the corrected A/B.
  No publish performed here. Do not send emails / place orders.
- Note: previously-resolved CLOSE records (if any exist in `data/tradelog.jsonl`)
  were written under the old semantics and will not have structural `R`. New
  resolutions use the corrected logic; a clean A/B read accrues from now on.
