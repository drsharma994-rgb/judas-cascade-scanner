# Server Reconcile vs. Reference — Handoff

Compared the current `server.js` against the pasted reference. The server was **already
current** for nearly the entire feature checklist. Only two reference items were genuinely
missing; both were added **additively / non-breaking**, with no change to the existing
`/api/tradelog/*` UI endpoints, Telegram safety, or public-data-only scanning.

## Already present (no changes needed)

Lightweight in-memory rate limiting (`rateLimit` factory; `scanLimiter` 4/min,
`telegramLimiter` 5/min, `tradelogLimiter` 20/min); static PWA serving; Telegram connector via
`callConnector` → `execFile("external-tool", …)` (no shell, manual button-triggered only, no
automatic messages); `/api/telegram/chats` and `/api/telegram/alert` with HTML sanitization
(`tgEscape`, `normalizeChats`, `buildTelegramMessage`); `/api/health` with a `DeltaPublic`
reachability probe; `/api/scan` with `market_regime`, `summary`, `report`, and `tradelog`
auto-log (`tradelog.logSetup(passed, cfg)`); `/api/tradelog/expectancy`, `/api/tradelog/recent`,
`/api/tradelog/resolve`.

## Patched (missing vs. reference)

1. **Legacy `/api/log*` alias endpoints** — the reference uses `/api/log`, `/api/log/raw`,
   `/api/log/resolve`. The three tradelog handlers were extracted into named functions
   (`handleExpectancy`, `handleRecent`, `handleResolve`) and registered on **both** the
   canonical `/api/tradelog/*` paths (kept intact for the current UI) **and** the legacy
   `/api/log*` aliases. Added `app.use("/api/log", tradelogLimiter)` so the aliases are
   rate-limited too. No `/api/tradelog/*` route was removed or renamed.

2. **Optional background outcome resolver** — `startBackgroundResolver()` runs only when
   `RESOLVE_INTERVAL_MIN` is a positive number (**disabled by default**). It uses a `running`
   overlap guard, `timer.unref()` so it never keeps the process alive, and public Delta data
   only (no orders). Invoked inside the `app.listen` callback.

## Files changed

- `server.js` — `app.use("/api/log", tradelogLimiter)`; extracted named tradelog handlers and
  registered legacy `/api/log*` aliases alongside `/api/tradelog/*`; `startBackgroundResolver()`
  guarded by `RESOLVE_INTERVAL_MIN`.

(No changes to `scanner.js`, `tradelog.js`, `app.js`, `index.html`, `sw.js`. No new dependencies.)

## Verification

- `npm run check` (server.js, scanner.js, app.js, tradelog.js) → **PASSED**.
- Live smoke test (`PORT=8000 node server.js`):
  - Startup log clean; **no** background-resolver line (confirms `RESOLVE_INTERVAL_MIN` default off).
  - `GET /api/health` → **200**.
  - `GET /api/tradelog/expectancy` → **200**.
  - `GET /api/log` (alias) → **200**, returns expectancy JSON.
  - `GET /api/log/raw` (alias) → **200**, `{ok, count, records}`.
  - `POST /api/log/resolve` (alias) → **200**, `{ok, resolved, expectancy}`.
  - Server stopped; test `data/` removed; port 8000 free.

## Next steps for the parent

- None required to run. Restart `node server.js` (or `npm start`) to pick up the changes.
- To enable the optional resolver: set `RESOLVE_INTERVAL_MIN=<minutes>` in the environment.
- No service-worker bump needed — this is a backend-only change (no client UI/asset change).
- Not published. Public Delta data only; no orders, no keys, no private account access.
