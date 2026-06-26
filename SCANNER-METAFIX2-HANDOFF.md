# Delta Scanner v6 — Meta-Fix Phase 2 Handoff

Decisive refactor of the over-built 8-gate scanner into a leaner, **measured** engine.
Scan-only, public Delta endpoints only, no orders / no auth / no secrets, NFA copy
preserved. All changes additive on the API (legacy fields kept for cron compat).

## Directive → implementation

1. **Collapse redundant gates/scoring** — honest 4-family model is now primary:
   `direction, structure, funding, execution` → `familyList/familyScore/corePass/honestVerdict`
   (CLEAN/WATCH/SKIP). 8-gate kept as `[legacy]` diagnostics only. UI card leads with the
   honest strip; bias bar relabeled to non-probability "lean score".
2. **Structural exits + time-stop** — `target_mode` now defaults to `structural_first`
   (opposite-side Judas liquidity as primary target, floating RR). `rr_floor` (1.5) skips
   below-floor plans with `noTradeReason`. `tpFixed/rrFixed` retained as A/B metadata.
   Coded time-stop (`time_stop_bars` 192) closes unresolved trades → `TIME` outcome w/ realized R.
3. **Funding as signal** — `classifyFunding` → `fundingState`
   (neutral/crowded_long_fade_short/crowded_short_fade_long/extreme_veto) + per-direction
   `fundingSignal` (favor/against/neutral/veto) + continuous `fundingAlpha`. No fake
   confidence from mild/neutral funding. Surfaced on card + Outcome Lab.
4. **Neutralize BTC beta** — `btcRegimeAlign`/`betaGate` (post-regime) fold into
   `executionStatus`. Server adds correlated-exposure **basket cap**: multiple alt
   shorts/longs in one group+dir collapse to a basket; non-lead members get
   `correlatedExposureWarning` and ENTER→WAIT. `exposure_baskets[]` in response.
5. **Outcome logging / data-driven selection** — every clean/passed setup logged; expectancy
   grouped by independent signals: `by_family`, `by_funding_signal`, `by_funding_state`,
   `by_group` (not gate count). Paired-only `structural_minus_fixed_R` (`paired_n`).
   `min_n=120`; UI shows a loud UNVALIDATED banner until N reaches min_n.
6. **Back-compat/deploy** — `sym/dir/side/entry/stop/target/rr/score8/passed` preserved;
   new `clean[]` array added alongside `passed[]`. SW cache delta-v4-15 → **delta-v4-16**.

## Files changed (Phase 2)
- `scanner.js` — structural-first default, `fundingSignalFor`, honest families + `honestVerdict`.
- `server.js` — correlated-exposure basket cap, `clean[]`, `exposure_baskets[]`.
- `tradelog.js` — `by_funding_signal/by_funding_state/by_group` expectancy groupings.
- `app.js` — funding signal + basket warning in honest strip; grouped + per-family rows and
  UNVALIDATED banner in Outcome Lab; structural target-mode label.
- `index.html` — `.hswarn` style. `sw.js` — cache bump to delta-v4-16.

## Verification
- `npm run check` → PASSED (server, scanner, app, tradelog).
- `/tmp/ab_test.js` → **9 passed, 0 failed** (tie→SL, null tpStruct, paired diff 0.75,
  structural sample 1.5, fixed-plan win rate, fixed-plan closure, null structural R).
- Live smoke (PORT=8021, default structural-first): health 200; `POST /api/scan {max_symbols:40}`
  → 98 rows, `market_regime.available=true`; every row carries honestVerdict, fundingSignal,
  fundingState, corePass, familyScore, targetMode, betaGate, btcRegimeAlign,
  correlatedExposureGroup, judasMode. 12 cascade rows → `targetMode=structural`
  (rr-below-floor no-trades as expected). `clean[]`, `exposure_baskets[]` present.
  Expectancy: `min_n=120`, `closed=0`, `verdict_ready=false`, `by_family/by_funding_signal/by_group` present.
- Order-safety grep (place order / createOrder / /orders / api-key / signature) → **empty**.

## Known limitations
- app.js (~3k-line IIFE) not browser-rendered here; UI changes are additive and pass
  `node --check` but were not visually verified.
- This scan surfaced 0 clean/passed setups (current market) → basket warning + structural-mode
  card paths confirmed via the 12 cascade rows + ab_test, not a live passing setup.

## Deployment
- project_path: `/home/user/workspace/judas-cascade-app`
- dist_path: none (Express serves static files directly)
- build command: none (`npm install` only; dep: express)
- run command: `npm start` (→ `node server.js`)
- port: 8000 (default; smoke used PORT=8021 override)
- **publish_website: recommended YES** — backend + frontend changed, SW bumped to delta-v4-16.
  Default behavior is safe (structural-first is the intended new default; fixed_rr opt-in via
  `target_mode`). Did NOT publish, email, or place orders — parent agent decides deploy.
