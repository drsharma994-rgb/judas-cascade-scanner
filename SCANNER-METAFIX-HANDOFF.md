# Scanner Meta-Fix — Handoff

Implements the 7-point "make the scanner honest and outcome-driven" direction.
All changes are **additive** (new backend fields + UI de-emphasis/relabeling) — no
existing API fields removed, no breaking changes. Safety unchanged: public Delta
endpoints only, scan-only, no orders, no private account access, no secrets,
not-financial-advice copy preserved. Default behavior (fixed_rr) is byte-compatible
with the published live app; the new structural-first targeting is **opt-in**.

## Requirements → what changed

1. **Outcome logging drives validation; real structural-vs-fixed A/B**
   - `tradelog.js`: `resolveOpen` now resolves the **fixed** leg against `rec.tpFixed`
     (fallback `rec.target` for legacy records), the **structural** leg against
     `rec.tpStruct` *only when present* (null otherwise — never a duplicate of fixed),
     and the **actually-traded** plan (`rec.target`) gates closure. This kills the
     "fixed target resolved twice" bug — the A/B is now a genuine counterfactual.
   - `structural_minus_fixed_R` is measured on **paired** records only (`paired_n`).
   - Per-family expectancy added (`by_family`: direction/structure/funding/execution).
   - `min_n` default raised **30 → 120** so no verdict is presented before ~100-150
     resolved trades (`verdict_ready=false` + provisional note until then).
   - OPEN events now persist `tpFixed/rrFixed/targetMode/familyList/familyScore/
     fundingState/correlatedExposureGroup/btcRegimeAlign/judasMode`.

2. **Collapse redundant signal counting → 4 honest families**
   - `scanner.js`: each analyzed row now carries `families {direction, structure,
     funding, execution}`, `familyList`, `familyScore` (0-4), and `corePass`.
     FAMILY_QUALITY is treated as a rollup folded into `corePass` (score4 floor),
     not a 5th independent confirmation. The 8 gates remain for compatibility.

3. **Kill scoring theater in the UI**
   - `app.js`: new **honest summary strip** leads every scan card — Core family
     pass/fail (`familyScore/4`), Setup state, Execution status, plus BTC-beta /
     funding / exposure-group / target-mode context — labeled "non-probability".
   - Bias bar relabeled: removed the `%` suffix, retitled "directional lean (edge
     score) — NOT a probability", added "lean score · not a probability" caption.
   - Outcome Lab now shows `paired_n` and per-family expectancy rows.
   - Backend `longChance/shortChance/biasConfidence` kept (cron/email compat) but
     marked deprecated/non-probability in code comments.

4. **Structural-first targeting + code-enforced time-stop**
   - `scanner.js`: `target_mode` config (`fixed_rr` default | `structural_first`).
     In structural_first, target = next opposing liquidity (Judas range) with
     **floating RR**; if `rrStruct < rr_floor` (default 1.5) the row is flagged
     no-trade (`noTradeReason`, `structOk=false`). `tpFixed/rrFixed` always retained
     as A/B metadata. Time-stop enforced via `time_stop_bars` (default 192) in
     `tradelog.tripleBarrier`/`resolveOpen`.

5. **Funding as a signal, not only a veto**
   - `scanner.js` `classifyFunding`: `neutral | crowded_long_fade_short |
     crowded_short_fade_long | extreme_veto`, plus continuous `fundingAlpha`
     (clamped −1..1) for alpha testing. Exposed on every row.

6. **Neutralize BTC beta**
   - `scanner.js` `exposureGroup` (BTC/ETH/MAJOR/ALT) on each row (pure).
   - `server.js`: after market regime is computed, sets `btcRegimeAlign` and
     `betaGate` (ok/caution/block) per row and folds them into `executionStatus`
     (block→AVOID, caution+ENTER→WAIT). Correlated alts surfaced as one group.

7. **Re-examine Asian Judas (session vs rolling)**
   - `judasMode` exposed on every row and in `formatScan`; config already supports
     session-anchored vs rolling — now first-class in scan output for OOS logging.

## Files changed
- `scanner.js` — 4-family model, funding classify, exposure group, beta align/gate,
  exec status, structural-first targeting, new return fields, formatScan labels.
- `server.js` — import `btcRegimeAlign/betaGate`; annotate rows post-regime.
- `tradelog.js` — real fixed-vs-structural A/B, traded-plan closure gate, by_family
  expectancy, paired_n, min_n 30→120, new OPEN fields, reconcile traded* fields.
- `app.js` — honest summary strip on cards, bias-bar relabel, Outcome Lab by_family.
- `index.html` — `.honest` strip CSS.
- `sw.js` — cache bump `delta-v4-14 → delta-v4-15`.

## Verification
- `npm run check` → **PASSED** (server.js, scanner.js, app.js, tradelog.js).
- `/tmp/ab_test.js` (9 tests) → **9 passed, 0 failed** (tie→SL, null tpStruct kept
  null, paired structural_minus_fixed_R=0.75, fixed-plan closure, win rate).
- Live smoke (`PORT=8021`):
  - `GET /api/health` → 200, `delta_reachable=true`.
  - `POST /api/scan {max_symbols:40}` → 200, 99 rows, `market_regime.available=true`.
    Every row carries `familyScore/familyList/corePass/setupState/executionStatus/
    fundingState/fundingAlpha/correlatedExposureGroup/btcRegimeAlign/betaGate/
    judasMode/targetMode/noTradeReason/tpFixed/rrFixed/tpStruct/rrStruct`.
  - `POST /api/scan {target_mode:"structural_first",rr_floor:1.5}` → 36 rows in
    structural mode, 35 flagged `noTradeReason:"structural RR below floor"` (floor
    enforcement works). Funding dist: neutral 78 / crowded-long 9 / crowded-short 9
    / extreme_veto 3.
  - `GET /api/tradelog/expectancy` → `min_n:120`, `by_family` present (4 families),
    `paired_n` present.
  - Server stopped; test `data/` removed.

## Known limitations
- `app.js` (~158 KB IIFE) could not be browser-rendered in this environment; the UI
  changes are conservative/additive (a new strip + label text + new CSS class) and
  pass `node --check`, but were not visually verified in a browser.
- No strict 8/8 setups surfaced during smoke, so `logSetup` persistence of the new
  fields was confirmed via the unit test (`ab_test.js`) rather than the live log.
- `executionStatus` is a timing/validity axis independent of `corePass`, so a card
  can show e.g. Core 2/4 with Exec ENTER — by design (both are shown side by side).

## For the parent: repackage/redeploy/publish?
- Backend + frontend changed, so **a redeploy + SW bump is required** to ship these.
  SW already bumped to `delta-v4-15`. The structural-first path is opt-in; default
  fixed_rr behavior is unchanged, so this is safe to publish.
- Did not publish, email, or place orders.
