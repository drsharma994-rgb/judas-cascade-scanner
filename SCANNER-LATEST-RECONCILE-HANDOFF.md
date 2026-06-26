# Scanner Latest Reconcile vs. Reference — Handoff

Compared the pasted `scanner.js` v4 reference against the current
`/home/user/workspace/judas-cascade-app/scanner.js` (live v6).

**Verdict: the current scanner already implements the entire reference checklist —
no code changes were needed.** The one divergence (`max_symbols` handling) is newer,
documented, more-protective v6 logic that was deliberately preserved rather than
reverted to the older reference behavior. Safety unchanged: public Delta endpoints
only, no orders, no private account access, no secrets. `tradelog.js` A/B logic
untouched.

## Reference checklist — all already present

1. **`directionalBias`** (scanner.js:41) and **`validityFreshness`** (scanner.js:105)
   — deterministic, rule-based, with finite-number guards and explicit no-PnL-history
   labels (`"live evidence (no PnL history)"`, `"rule-based freshness"`).
2. **Indicator helpers** — `volumeRatio` (:310), `vwapLast` (:322), `structuralTarget`
   from Judas range hi/lo (:397); **retries/backoff** in `DeltaPublic._get` (:425) with
   `max_retries` in `buildConfig` (:896, clamped 1–6).
3. **Fixed-RR target is primary/gate-bearing** — `targetMode = "fixed_rr"` (:609);
   `target`/`rr` remain the fixed plan that `STRUCTURAL_RR_SL` depends on (unchanged).
4. **Additive structural-vs-fixed metadata** — `tpFixed`, `rrFixed`, `tpStruct`,
   `rrStruct`, `entryTime`, `entryTf` on every analyzed row (:604–611, :699).
5. **Full-universe scan** — `max_symbols` default **1000** (:892). *Divergence, see below.*
6. **Confirmatory fields** — `oi`, `oiUsd`, `volRatio`, `vwap`, `vwapLoc`, `emaLoc`,
   `ema50`, `liqQuality` (:640–650, :700–706).
7. **`marketRegime`** BTC/ETH CUSUM (:746); **`formatScan`** includes Bias and Validity
   lines (:817) and Formation Radar NEAR (7/8) / FORMING (5–6/8) sections (:835–847).

## The one divergence (intentionally NOT changed)

Reference #5 asks for `max_symbols` clamp `1..2000` with *explicit low values honored*
(no forced 25/40 cap). The current code instead treats any requested value `≤120` as
`1000`:

```js
max_symbols: (() => {
  const requested = Math.max(1, Math.round(num(p.max_symbols, 1000)));
  return requested <= 120 ? 1000 : requested;   // legacy-cap → full universe
})(),
```

This is a deliberate, documented v6 "emergency backward-compatibility fix": cached
mobile PWA clients still POST the old demo caps (25/40/120), and honoring them would
silently restrict the live futures scan. Reverting to the reference's "honor explicit
low values" would reintroduce exactly that regression for the **already-published live
v6 app**. Per "preserve superior existing logic / make no unnecessary changes," this
newer protective behavior was kept. (The reference's `2000` upper clamp is moot in
practice — Delta India lists far fewer perps, and `selectUniverse` simply slices the
universe, so there is no functional gap.)

## Files changed

- **None.** No edits to `scanner.js`, `server.js`, `tradelog.js`, `app.js`,
  `index.html`, or `sw.js`. No new dependencies.

## Verification

- `npm run check` → **PASSED** (server.js, scanner.js, app.js, tradelog.js).
- Live smoke test (`PORT=8013 node server.js`):
  - `GET /api/health` → **200**.
  - `POST /api/scan {max_symbols:40}` → **200** in ~9.8s: **118 evaluated rows**, 4 strict
    8/8, `market_regime.available = true`. The 118-row count confirms the `≤120→1000`
    override (40 was expanded to the full universe).
  - **Field presence (all rows):** `tpFixed`, `tpStruct`, `targetMode` (`"fixed_rr"`),
    `entryTime`, `entryTf` (`"15m"`), `biasSide`, `validityStatus`, `rrFixed`, `rrStruct`
    — **all PASS**.
  - Server stopped; test `data/` removed.

## Next steps for the parent

- **No repackage/redeploy/publish required for the scanner** — it was already current;
  nothing changed. The live v6 build already contains this engine.
- No service-worker bump needed (no file changed).
- Not published, no emails, no orders.
