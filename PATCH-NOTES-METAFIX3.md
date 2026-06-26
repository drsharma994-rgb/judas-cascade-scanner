# Patch Notes — Meta-Fix Phase 3 (bug remediation)

Three confirmed bugs fixed. All changes verified with `node --check` (server,
scanner, app, tradelog all pass). Scan-only / public Delta endpoints / no orders /
no auth / no secrets — unchanged. No API fields removed.

## 1. `max_symbols` silent override — FIXED (scanner.js)
**Was:** `buildConfig` rewrote any requested `max_symbols <= 120` to `1000`
(full universe), disguised as a "backward-compatibility fix". Lowering the cap
on mobile was silently ignored, and `{max_symbols:40}` smoke tests returned the
full universe — making those tests meaningless.
**Now:** request is honored, clamped to `[1, 1000]`:
```js
max_symbols: Math.max(1, Math.min(1000, Math.round(num(p.max_symbols, 1000)))),
```
Default (no field) is still the full universe via `num(..., 1000)`.

## 2. NaN-poisoned directional bias — FIXED (scanner.js + app.js)
**Was:** guards used `typeof x === "number"`, which is `true` for `NaN`. A NaN
`rsi`/`fund` poisoned `score`, so `longChance/shortChance/biasConfidence` became
`NaN`. The fallthrough then emitted a spurious **"Strong Short Bias"** (NaN > NaN
is false → SHORT; all gap thresholds false → "Strong"). The client (`app.js`)
carried its own copy of `directionalBias`, so the bias bar the user sees had the
same bug — the server fix alone would NOT have fixed the UI.
**Now:** every `typeof <obj>.<prop> === "number"` guard is `Number.isFinite(...)`
(3 in scanner.js, 25 in app.js, incl. the row-normalization block feeding the
bias). Proof: NaN input → `NEUTRAL 50/50` (was `SHORT Strong NaN/NaN`); valid
input unchanged (`53/47` both before and after).
**Note:** `Number.isFinite` also rejects `Infinity` (old `typeof` accepted it).
For these price/momentum fields that is correct, never a regression.

## 3. 429 / backoff retry — already FIXED upstream (scanner.js `_get`)
Confirmed present: retries 429/5xx with capped exponential backoff + jitter,
fails fast on other 4xx, honors `max_retries`. Minor future nicety: it ignores
the server `Retry-After` header and uses its own schedule. Left as-is.

## Bonus (additive, optional)
- `app.js`: `honestVerdict` (CLEAN/WATCH/SKIP) now leads the honest strip when
  the backend supplies it; silently absent for older cached responses.

## Deploy
- `scanner.js`/`server.js`/`tradelog.js` are server-side (Node/Express) — the
  bias-bar fix and `max_symbols` fix ship on backend redeploy.
- `app.js` is the browser client. `sw.js` cache bumped `delta-v4-17 -> delta-v4-18`
  so installed PWAs replace the stale `app.js` instead of serving it from cache.
- No build step (Express serves static files). `npm install` (dep: express),
  `npm start`. Backend needs a Node host (e.g. Render / Railway / Fly); GitHub
  Pages alone cannot serve `server.js`.
- `app.js` could not be browser-rendered in the patching environment; the
  `honestVerdict` chip is a single additive element and passes `node --check`,
  but verify it visually on device once.
