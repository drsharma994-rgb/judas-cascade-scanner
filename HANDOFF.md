# Delta Scanner v4 — Strict 8-Gate · Handoff

Mobile-first crypto trading dashboard that merges the strict **Delta Scanner v4 / Judas 8-gate**
bot logic (`delta-macd-bot/judas_8gate_bot.py`) into the Judas Cascade app UI, now backed by a
**Node/Express server that fetches live Delta Exchange India public market data** and returns
strict 8-gate scan results to the UI. Surfaces **only** setups that pass all eight de-correlated gates.

## What's new in this upgrade (live backend)

The app is no longer demo-only. A Node/Express backend (`server.js` + `scanner.js`) now:

- Serves the static PWA **and** the API from one origin/port.
- Fetches **live** Delta India public data (no API secrets) and runs the full 8-gate engine in JS,
  ported faithfully from `judas_8gate_bot.py` (same indicators, gate order, scoring, report format).
- Returns the exact terminal report string, setup list, gate status, summary, and metadata flagging
  `LIVE DELTA PUBLIC DATA`.
- The frontend calls the backend by default and **falls back to deterministic, clearly-labelled DEMO
  data** if the backend or Delta feed is unreachable.

## Auto Watch upgrade (in-app automation, no background scheduler)

This upgrade adds in-app automation and richer analytics **without** enabling real orders or any
external/background recurring task. Everything runs only while the app tab is open and is held in
memory (no `localStorage`/`sessionStorage`/`indexedDB`/cookies).

### 1. Auto Watch mode (Scan view)
- Toggle **Start/Stop Auto Watch** (`#awToggle`). While running, it re-runs the normal scan on a
  user-selected interval: **1m / 3m / 5m / 15m** (`#awIntSeg`, default **5m**).
- Metrics shown live: **next-scan countdown** (`#awCountdown`), **last scan** time (`#awLast` / UTC),
  **scan count** (`#awCount`), and **status** (`#awStatusMetric`: Idle / Scanning / Waiting).
- A 1-second ticker (`awTick`) drives the countdown. **The countdown pauses when the tab is hidden**
  (`document.hidden`) and resumes on focus — there is no background scheduler, service-worker sync, or
  cron. Closing or backgrounding the app stops everything.
- Interval buttons are **locked while running** (change interval only when stopped).
- A `scanInFlight` guard prevents overlapping scans if one tick fires while a scan is still in flight.

### 2. Duplicate-alert protection (in-memory, per session)
- Each setup gets a stable **setup key** = `symbol + side + rounded(entry/SL/TP) + gate score`
  (`setupKey()`); `roundLevel()` rounds price levels to ~4 significant figures so small live drift does
  not create false "new" setups.
- Two in-memory `Set`s track state for the session: `state.seenKeys` (ever surfaced) and
  `state.sentKeys` (already pushed to Telegram).
- Cards show a **state badge**: `new` (first time seen), `seen` (surfaced before), or `sent` (already
  alerted to Telegram this session) via `setupState()`.
- Auto Watch logs an in-app alert **only for NEW passed setups**, and **never re-sends a duplicate**
  Telegram message for the same setup key in the same session.
- Refreshing the page clears all keys (fresh session) — by design, since nothing is persisted.

### 3. Optional Telegram Auto Alert (Alerts view, in-app only)
- New toggle **Auto-send NEW 8/8 during Auto Watch** (`#tgAutoSw`), **default OFF**.
- Guard: turning it ON **requires a chat selected/entered first** — otherwise it stays OFF and shows
  "Choose a chat or enter a chat ID first, then enable auto-send."
- When ON **and** Auto Watch is running, each *new* strict 8/8 setup is auto-sent once via the existing
  `POST /api/telegram/alert` path; `state.sentKeys` prevents duplicates. It **disarms itself** if the
  Telegram connector becomes unavailable, with a graceful message.
- Resets to OFF on reload. Manual **Send latest 8/8 setup** and **Send full scanner report** buttons
  are unchanged and still work independently.

### 4. Setup quality analytics (per card)
- A **Quality Score** panel (0-100, `qualityScore()`) distinct from the binary 8/8 gates. Weighted
  components (`qualityComponents()`): RR 0.16, ATR-based stop 0.13, Family 0.18, MTF 0.14, Funding 0.10,
  RSI room 0.09, CUSUM 0.10, Liquidity 0.10 — each normalized 0-100 and shown as a labelled bar.
- A **Target Confidence** label — Conservative / Balanced / Aggressive (`targetConfidence()`) — derived
  from the score band.
- For high-quality full 8/8 setups, an **expected move window** text (e.g. "48h breakout watch",
  `expectedWindow()`). This is descriptive context only — **no profit is promised**.

### 5. Market regime strip (Scan view, `#regimeStrip`)
Derived from the last scan: count of **LONG vs SHORT** passed setups (`#rgLong`/`#rgShort`), overall
**market bias** (`#rgBias`), **average funding** across the universe (`#rgFund`), and the **top quality**
setup (`#rgTop`). Empty/neutral when no scan has run yet.

### 6. Export / copy helpers
- **Copy report** button (`#copyReport`) on the Scanner Report header copies the latest terminal report
  text to the clipboard.
- **Copy setup** button per card (`data-act="copy"`) copies a plain-text summary of that setup.
- `copyText()` tries `navigator.clipboard`, falls back to `document.execCommand('copy')`, and finally to
  a selectable textarea if the iframe blocks clipboard access. Inline feedback confirms each copy.

### Safety preserved
No real orders are placed from the browser or backend; live execution stays locked; no secrets in the
frontend; **no `localStorage`/`sessionStorage`/`indexedDB`/cookies** (all new state is in-memory on
`state.*`); Telegram features degrade gracefully when the connector is unavailable.

## Execution Strategy upgrade (per-setup execution layer)

This upgrade adds a detailed **Execution Strategy panel** under every setup card, matching the trading
logic the operator already uses. Full details live in **`EXECUTION-STRATEGY-HANDOFF.md`**; summary:

- **Status engine** (`execStatus` in `app.js`): each setup is classified **Execution eligible** /
  **Wait for pullback** / **Chase risk** / **Invalidated** / **Avoid**, derived from live mark vs entry,
  stop distance (R), RR, quality score, family score, MTF agreement, CUSUM alignment, funding and regime.
  Precedence: Invalidated > Avoid > Chase > Wait > Eligible.
- **Entry validation** (`entryZone`, `favorR`, `pastStopR`): proximity zones ideal / acceptable / chase /
  invalidated with a visual meter, price delta % from entry, and R-in-favor. SHORT and LONG are handled
  symmetrically (ideal = at/near entry or a healthy pullback against the trade).
- **Position sizing** (`positionSizing`): in-memory inputs **Account size**, **Risk %**, **Max leverage
  cap** → risk amount, stop distance, suggested units + notional, leverage caution, and max loss if SL
  hits. **No persistence — in-memory only** (per requirement).
- **Execution plan levels** (`execPlan`): entry plan (limit/market by proximity), SL + % risk, **TP1 at
  1R**, **TP2/final at configured RR**, trailing remainder after TP1, break-even rule, and partial
  booking split driven by **Book % at TP1** (default 50/50, adjustable).
- **Invalidation checklist** (`invalidationList`) and **5-step trade-management timeline**
  (`tradeTimeline`): pre-entry checks → entry trigger → TP1/BE → final TP/trailing → forced exit.
- **Telegram upgrade**: manual and auto-send setup payloads now carry an `exec` object
  (`execSummary`); `server.js` `buildTelegramMessage` renders status, action, current price, TP1/TP2 with
  book %, SL risk, BE rule, sizing (when available) and invalidation bullets. Auto-send still only fires
  when the existing toggle is armed.
- **Copy Execution Plan** button per setup (`copyExecPlan` → `plainExecPlan`, reuses `copyText`).
- **Disclaimer**: every panel and copied plan includes *"Technical setup only — not financial advice.
  Follow risk size and SL."* No order is placed; live execution stays locked; still no browser storage.
- New params in **Account & Risk** settings group: `max_leverage` (default 10, 0 = no cap) and
  `tp1_book_pct` (default 50).

## Strategy Match + Solid-Only upgrade (assistant decision overlay)

This upgrade adds a **Strategy Match** layer that turns each raw 8/8 setup into an assistant-style
trade decision, plus the user's **solid-only** rules. Full details in **`STRATEGY-MATCH-HANDOFF.md`**;
summary:

- **Rule-based grade engine** (`strategyMatch` in `app.js`): each setup graded **A+ / A / B /
  NO TRADE** (deterministic checklist, **not** a probability or win rate), with exact actions
  (`Enter now with partial size`, `Wait for pullback/retest`, `Avoid / setup invalidated`,
  `Do not chase`), a **size multiplier** (A+ ideal 1.00× → B 0.25× → No Trade 0×, reduced on Fam 3/4,
  funding mixed, wide stop, chase, mixed regime), and **reason chips**.
- **Strategy Match panel** per card (`strategyPanelHTML`) above the renamed **Setup Quality** panel.
- **Quality Score renamed → "Setup Quality"** with subtitle "checklist score · not a probability or
  win rate". No "confidence %" or "win rate" labels anywhere live.
- **Strategy profile control** (Settings): Balanced / **Strict Assistant (default)** / Ultra Strict —
  drives sorting, visibility, badges, and the minimum Telegram auto-send grade.
- **"My logic"** explainer card + **"Solid-only strategy rules"** keep/drop card:
  - **Keep:** funding > 0.3% block, RSI exhaustion block, EMA cross/trend, MTF cascade (4h/1h/15m/5m
    target), Judas/Asian range, Delta India API only.
  - **Drop:** confidence % formula, AI ensemble score, win-rate labels, 10+ competing signal layers.
  - **Alert rule:** *"Fire an alert when the MTF cascade is 4/4 + Judas confirmed + funding clean +
    RSI not exhausted — and log every outcome."*
  - **MTF note:** target 4h/1h/15m/5m; scanner uses configured timeframes (default 4h/1h/15m → 3/3),
    labelled rather than inflated.
- **Sorting A+ > A > B > No Trade** then Setup Quality; **raw 8/8 report preserved exactly**
  (`reportKept` never profile-filtered).
- **Telegram**: payload + `server.js buildTelegramMessage` add a Strategy Match block (grade,
  action, size, top reasons) with no AI/probability/win-rate labels. **Auto-send respects the
  profile's minimum grade** (default A; Ultra Strict A+).
- `sw.js` cache bumped `delta-v4-5` → `delta-v4-6`. Safety unchanged: no real orders, no secrets in
  frontend, no browser storage.

## Confirmatory Signal Layer upgrade (rule-based confirm / reduce / block)

This upgrade adds a **deterministic** confirmatory layer that runs **after** the strict 8-gate verdict
and the Strategy Match grade. It combines technical confirmation, crypto-native fundamentals, and
market regime into one of four statuses. **It is never a probability, win-rate, or forecast**, and it
**never edits the raw scanner report**. See `CONFIRMATORY-LAYER-HANDOFF.md` for the full breakdown.

- **Statuses:** `GREEN` Entry allowed · `YELLOW` Wait for retest · `ORANGE` Reduce size · `RED` No trade.
  Precedence is `RED > ORANGE > YELLOW > GREEN`.
- **Eight components** (each `pos`/`neg`/`warn`/`na`): BTC/market regime, funding pressure, open
  interest presence, volume confirmation, VWAP/EMA location, Judas/retest, liquidity quality,
  event/news risk (always “manual check” — no scraping).
- **Per-setup panel** (`confirmatoryPanelHTML`) renders between Strategy Match and Setup Quality:
  status + action, size-adjust note with combined multiplier, the 8-component grid, reason chips, and
  an explainer footer. CSS classes `.cfpanel/.cftitle/.cfhead/.cfstatus/.cfaction/.cfsize/.cfgrid/`
  `.cfrow/.cfchip/.cfwhy` (ORANGE uses a distinct `#ff8a3d`).
- **Backend:** `scanner.js` enriches `analyze()` with `oi/oiUsd`, `volRatio`, `vwap/vwapLoc`,
  `ema50/emaLoc`, `liqQuality`; new `marketRegime(client,cfg)` computes a CUSUM BTC/ETH regime once per
  scan. `server.js` returns `market_regime` and adds a Confirmatory block to `buildTelegramMessage()`.
- **Telegram:** payload `setup.confirm` (`confirmPayload`) carries `statusLabel`, `action`, `sizeNote`,
  `combinedMult`, `topReasons`. **Auto-send is gated:** only `GREEN`/`YELLOW` with Strategy A/A+ are
  sent automatically; `RED` and Strategy `NO TRADE` are never sent; `ORANGE` is manual-only.
- **Settings:** a “Confirmatory Signal Layer” explainer card in `renderStrategy()` states it only
  confirms/reduces/blocks after 8/8 + Strategy Match, lists the four statuses, and names the
  crypto-native fundamentals (liquidity, funding, OI, BTC dominance/regime, event risk) — no fake
  equity-style fundamentals.
- `sw.js` cache bumped `delta-v4-6` → `delta-v4-7`. Safety unchanged: no real orders, no secrets in
  frontend, no browser storage; raw scanner report preserved byte-for-byte.

## Files (all in `/home/user/workspace/judas-cascade-app/`)

| File | Status | Purpose |
|---|---|---|
| `server.js` | **new** | Express server: serves static app + `GET /api/health` + `POST /api/scan`. No order placement. |
| `scanner.js` | **new** | JS port of the Python 8-gate engine: indicators (EMA/RSI/ATR/MACD/BB/CUSUM/VWAP), Judas sweep, 8 gates, `DeltaPublic` REST client, `formatScan`, `buildConfig`. |
| `package.json` | **new** | `express` dependency, `npm start` → `node server.js`, `npm run check` (syntax). Node ≥18. |
| `app.js` | **updated** | Backend-first `fetchScan` (POST `/api/scan`), result normalization, `/api/health` probe on load, LIVE vs DEMO banner logic, demo fallback. Default `max_symbols` is now 1000 so the live scanner covers the full Delta futures universe by default; lower it only when you want a faster partial scan. **+ Telegram module**: connector probe, load chats, send latest 8/8 setup, send full report, feedback states; tracks `state.lastReport`. |
| `index.html` | **updated** | Banner element now starts as "CONNECTING TO LIVE DELTA" and gets a teal `.live` style when live. **+ Telegram status card** in the Alerts view (status dot, Load chats, chat selector + manual ID fallback, silent toggle, two send buttons, live feedback) and supporting `.tg*` CSS in the existing dark theme. |
| `server.js` | **updated** | **+ Telegram endpoints** `GET /api/telegram/chats` and `POST /api/telegram/alert`, reached via the `external-tool` CLI using `execFile` (no shell) with a 20s timeout and graceful no-connector handling. |
| `scanner.js` | **updated (exec)** | `analyze()` now also returns `price`, `mark` (live mark or last close), and `entryDeltaPct` so the UI can validate live price vs the reference entry. |
| `server.js` | **updated (exec)** | `buildTelegramMessage` renders the optional `setup.exec` execution-plan block (status, action, current price, TP1/TP2 + book %, SL risk, BE rule, sizing, invalidation bullets); footer disclaimer reinforced. |
| `app.js` | **updated (exec)** | Execution Strategy engine (`favorR`, `pastStopR`, `entryZone`, `execStatus`, `EXEC_STATUS_META`, `positionSizing`, `execPlan`, `invalidationList`, `tradeTimeline`, `execSummary`), `executionPanelHTML`/`execIcon`/`plainExecPlan`/`copyExecPlan`, wired into `cardHTML`, `bindCardActions` (`copyexec`), and both Telegram payloads. New `max_leverage` + `tp1_book_pct` params. |
| `index.html` | **updated (exec)** | `.expanel` + `.ex*` CSS for the execution panel (status pill, entry-zone meter, plan/sizing grid, timeline, invalidation list, disclaimer, copy action); 1-column grid below 520px; no horizontal overflow at 375/390px. |
| `sw.js` | **updated** | Cache bumped to `delta-v4-5` (Execution Strategy upgrade); `/api/` and `/port/` requests are never cached (always network). |
| `manifest.webmanifest`, `favicon.svg`, `icon-192.png`, `icon-512.png` | unchanged | PWA assets, intact. |

QA screenshots: `/home/user/workspace/judas-cascade-qa/` (`live-load-mobile.png`, `live-scan-mobile.png`).

## API endpoints

### `GET /api/health`
Liveness + Delta reachability probe. Returns:
```json
{ "ok": true, "data_source": "LIVE DELTA PUBLIC DATA",
  "delta_base": "https://api.india.delta.exchange",
  "endpoints": ["/v2/products","/v2/tickers","/v2/history/candles"],
  "gate_labels": [...8...], "live_execution": "locked (run judas_8gate_bot.py separately)",
  "delta_reachable": true, "probe_ms": 492, "not_financial_advice": true }
```

### `POST /api/scan`
Body = the UI settings object (all `JudasConfig` params + `strict`). Returns:
```json
{ "ok": true, "live": true, "data_source": "LIVE DELTA PUBLIC DATA",
  "gate_labels": [...8...],
  "summary": { "universe": 40, "passed": 1, "strict": true, "scanned_at": "17:15 UTC", "took_ms": 2960 },
  "results": [ {sym, dir, entry, stop, target, rr, slPct, tpPct, score8, score4, famLong,
                mtfAgree, nTf, rsi, rsiThr, cusumDir, fund, judasOk, turnover, gates, gateList, passed}, ... ],
  "setups": [...strict 8/8 (or 6+/8 if non-strict)...],
  "passed": [...strict 8/8 only...],
  "report": "DELTA SCANNER v4 — HH:MM UTC\n…exact terminal format…",
  "meta": { "live_execution": "locked", "note": "Public Delta data only. No orders placed. Not financial advice." } }
```
On failure returns HTTP 422 with `{ ok:false, live:false, error, hint }` and the UI falls back to demo data.

### `GET /api/telegram/chats`
Lists available Telegram chats via the connector (`telegram_bot_api__pipedream` → `telegram_bot_api-list-chats`). Optional `?limit=` (1–100, default 50). Returns:
```json
{ "ok": true, "connector": true, "chats": [ { "id": "1035597319", "title": "My Group", "type": "group" } ], "count": 1 }
```
- **No connector token** (server started without `external-tools`): HTTP 200 with `{ ok:false, connector:false, chats:[], error, hint:"Restart the backend with external-tools credentials / Telegram connector required." }` — the app does not crash.
- Connector reachable but no chats yet: `ok:false, connector:true, chats:[]` with a hint to message the bot first or enter an ID manually.

### `POST /api/telegram/alert`
**Sends one message, only on explicit button press — never automatically.** Body:
```json
{ "chatId": "1035597319", "silent": false,
  "setup": { "sym":"BTCUSD", "dir":"long", "score8":8, "entry":67250, "stop":66100, "target":69500, "rr":2.0 } }
```
Provide **either** `setup` (object → concise strict 8/8 card) **or** `report`/`text` (string → full scanner report, wrapped in `<pre>`). The server builds and HTML-sanitizes the message itself (`parse_mode:"HTML"`), so the browser never crafts raw markup. `silent:true` maps to `disable_notification`. Sends via `telegram_bot_api-send-text-message-or-reply`. Returns:
```json
{ "ok": true, "sent": true, "chatId": "1035597319", "chars": 142 }
```
- `chatId` missing → HTTP 400 `{ ok:false, error:"chatId is required." }`.
- No connector token → HTTP 503 `{ ok:false, sent:false, connector:false, error, hint }`.
- Connector/Telegram error (bad chat id, etc.) → HTTP 502 `{ ok:false, sent:false, connector:true, error, hint }`.

**Connector call safety:** the `external-tool` CLI is invoked with `child_process.execFile("external-tool", ["call", JSON.stringify(payload)], { timeout: 20000 })` — arguments are passed as an argv array (no shell, no string interpolation). Missing CLI (`ENOENT`) → `ConnectorUnavailable` → friendly hint; timeout → "connector timed out"; `auth_required` → "reconnect the Telegram connector".

## How the data flows

`/v2/products?states=live` → keep `perpetual_futures` symbols → `/v2/tickers` → rank by turnover,
apply quote/turnover/max-symbols filters → for each symbol fetch `/v2/history/candles` per timeframe
(140 bars ≤15m, else 40) with bounded concurrency → run the 8-gate `analyze()` → strict = all 8 gates.

## Run / deploy

### Local
```bash
cd /home/user/workspace/judas-cascade-app
npm install
npm start            # node server.js — serves app + API on PORT (default 8000), binds 0.0.0.0
# open http://localhost:8000/ ; GET /api/health ; POST /api/scan
```
Backend port: **8000** (override with `PORT` env). Start command: **`node server.js`** (`npm start`).

### Telegram — required credentials
The Telegram endpoints reach the connector through the `external-tool` CLI, which is **only present when the backend is started with the `external-tools` credential preset**. Start the server with:
```
start_server(command="node server.js", project_path="/home/user/workspace/judas-cascade-app", port=8000, api_credentials=["external-tools"])
```
The credential token lasts ~10 min locally and is refreshed on every incoming frontend request after deploy. Without it, `/api/scan` and `/api/health` keep working; the Telegram card shows a red "connector unavailable — restart with external-tools credentials" status and send is blocked (no crash).

### Usage (operator)
Open the **Alerts** tab → the card probes the connector (no message sent). Press **Load chats** to populate the selector (or pick "Enter chat ID manually" and type a chat ID / `@username`). Optionally tick **Send silently**. Then press **⚡ Send latest 8/8 setup** (sends the top strict 8/8 from the most recent scan) or **📡 Send full scanner report**. Messages are sent **only** on these button presses.

### Perplexity deploy (`deploy_website`)
- The backend runs on port **8000**; `app.js` uses the `__PORT_8000__` placeholder which
  `deploy_website` rewrites to the authenticated proxy path. Locally the placeholder stays literal and
  the app uses same-origin relative `/api/...` (the Express server hosts both app and API).
- Steps:
  1. `start_server(command="node server.js", project_path="/home/user/workspace/judas-cascade-app", port=8000)`
  2. `deploy_website(project_path="/home/user/workspace/judas-cascade-app", entry_point="index.html")`
- The deployed static bundle (HTML/JS/PWA assets) is served from S3; `/api/*` calls proxy to the
  sandbox backend on port 8000.

## Safety (unchanged + reinforced)

- **No real orders from the browser or this backend.** `/api/scan` is read-only public data.
- **Live order execution stays locked and untouched** by this upgrade.
- **Telegram messages are never sent automatically** — only when the operator presses a button in the Alerts view (`POST /api/telegram/alert`). Scans never trigger a send.
- **No secrets in the frontend.** The browser never sees the Telegram bot token; it lives only in the backend runtime (injected by the `external-tools` credential preset). The frontend only sends a chat id + payload to the backend, which calls the connector.
- **No `localStorage`/`sessionStorage`/`indexedDB`/cookies** — all state is in-memory React-free vanilla JS state.
- **No API key fields in the frontend.** Live-trading toggles are booleans only; real Delta
  key/secret live solely in the Python bot's backend env.
- **Live execution stays locked.** To actually trade, run `delta-macd-bot/judas_8gate_bot.py`
  separately with `ENABLE_LIVE_TRADING=true I_UNDERSTAND_LIVE_RISK=true --mode live --execute` and your
  own credentials. The web app only previews plans.
- **Nothing here is financial advice.**

## Verification done

- `node --check` passes for `server.js`, `scanner.js`, `app.js`.
- **Telegram, no connector token** (server started with CLI removed from PATH): `GET /api/telegram/chats` → HTTP 200 `connector:false` + restart hint; `POST /api/telegram/alert` → HTTP 200-level graceful error `connector:false`; `/api/health` still 200. App does not crash.
- **Telegram, connector available**: `GET /api/telegram/chats` returns `connector:true`; `POST /api/telegram/alert` reaches Telegram (a deliberately invalid test chat id returned Telegram's `400 chat not found`, confirming the send path + error handling without delivering a real message). **No real alert was sent during testing.**
- Playwright mobile (390px) on the Alerts view: green connector dot, status "Connected", status card + send buttons render in the dark theme; manual chat-ID input toggles correctly; no console errors. Screenshot: `qa-alerts-mobile.png`.
- Server started via `start_server`; `GET /api/health` → `ok:true, delta_reachable:true`.
- `POST /api/scan` over live Delta data: 8 symbols (3.0s) and 30 symbols (3.0s, surfaced a real
  **HYPEUSD SHORT 8/8** setup) — exact report format reproduced verbatim.
- Playwright mobile (390px): banner shows teal **LIVE DELTA PUBLIC DATA** on load (health probe),
  scan renders 8/8 card with all gate chips passing + exact report, status reads "LIVE DELTA",
  **zero console errors**. Demo-fallback verified (blocked `/api/scan` → amber "PREVIEW / DEMO DATA"
  banner + deterministic setups, no errors).

## Limitations

- Live scan latency scales with `max_symbols` (one candle request per symbol per timeframe). Default
  is now 1000, intended to cover the full Delta futures universe. Lower it only for a faster partial
  scan; the proxy allows up to 5 min per request. Concurrency is capped at 16 server-side.
- Delta funding `funding_rate` is already a percentage on Delta India, so keep Funding mult = 1.
- State (params, alerts, mode) is in-memory only — no `localStorage`/cookies (blocked in the sandbox
  iframe) and no DB. Refresh resets to defaults.
- If the sandbox/backend is not running, the deployed site still works but in clearly-labelled DEMO mode.
- Notifications use the Web Notifications API and require permission + a non-iframe context.

Nothing here is financial advice.
