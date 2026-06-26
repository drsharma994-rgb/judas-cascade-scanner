# Scanner Engine Reconcile vs. Reference — Handoff

Compared the current `scanner.js` against the pasted v4 strict 8-gate reference checklist. The
engine was **already up to date** for almost the entire feature set; only two reference items were
genuinely missing. Both were patched **additively**, with no change to gate logic, the primary
target/RR, or the APIs consumed by `server.js`, `tradelog.js`, or the UI. The Outcome Lab / tradelog
integration is preserved.

## Already present (no changes needed)

Delta India public REST client; strict 8-gate `analyze`; Formation Radar (`formationLabel`);
`directionalBias`; `validityFreshness`; `volumeRatio`; `vwapLast`; confirmatory fields
(`oi`, `oiUsd`, `volRatio`, `vwapLoc`, `emaLoc`, `liqQuality`); `marketRegime`; report output with
Bias and Validity lines.

## Patched (missing vs. reference)

1. **Retries / backoff in `DeltaPublic._get`** — transient failures (network errors, request
   timeout, HTTP 429 and 5xx) now retry with exponential backoff + jitter; permanent 4xx fail fast.
   Attempts controlled by optional `cfg.max_retries` (default 3, clamped 1–6; added to
   `buildConfig`). Read-only public requests only — no auth, no orders. No change to analysis
   semantics.

2. **Structural-vs-fixed target metadata** — added a `structuralTarget(side, entry, stop, rangeHi,
   rangeLo)` helper (opposite-side liquidity from the judas sweep range; returns `{tp, rr}` or null)
   and these **additive** fields on every analyzed row:
   - `tpFixed`, `rrFixed` — the existing fixed-RR projection (the gate-bearing target), exposed
     under explicit names.
   - `tpStruct`, `rrStruct` — alternative structural target (null when it doesn't form a valid
     same-direction reward).
   - `targetMode` — `"fixed_rr"` (documents that the primary `target` remains the fixed projection).
   - `entryTime` (ms epoch of the last entry-TF candle), `entryTf` (`cfg.entry_tf`).

   The primary `target`/`rr` are **unchanged**, so the `STRUCTURAL_RR_SL` gate and every downstream
   consumer behave exactly as before. `structuralTarget` is exported.

## Files changed

- `scanner.js` — `_get` retry/backoff; `max_retries` in `buildConfig`; `structuralTarget` helper;
  additive target-metadata fields on the `analyze` return; export of `structuralTarget`.

(No changes to `server.js`, `tradelog.js`, `app.js`, `index.html`, `sw.js`. No new dependencies.)

## Verification

- `npm run check` (server.js, scanner.js, app.js, tradelog.js) → **PASSED**.
- `structuralTarget` unit checks: long {tp:112, rr:2.4}, short {tp:46, rr:2}, invalid→null, no-dir→null.
- Live smoke test (`PORT=8000 node server.js`):
  - `GET /api/health` → **200**.
  - `POST /api/scan {max_symbols:40}` → **200**: 118 rows, 8 strict 8/8.
    - **0 rows missing** the 7 new fields; 10 rows carry a structural target.
    - `target === tpFixed` for **all** rows (primary target/gates unchanged).
    - `biasSide` and `validityStatus` present on **all** rows (existing features intact).
    - `tradelog` auto-log still fires (`{logged:8,...}`); Outcome Lab integration preserved.
  - Server stopped; test `data/` removed; port 8000 free.

## Next steps for the parent

- None required to run. Restart `node server.js` (or `npm start`) to pick up the changes.
- PWA clients: the service worker cache was **not** bumped (no client-facing UI/asset change — the
  new fields are additive backend data). Bump `sw.js` only if you later surface these fields in the
  UI. No publish performed.
