# Delta Scanner v4 — Execution Strategy Layer · Handoff

This upgrade adds a detailed **Execution Strategy panel** beneath every setup card in the live Delta
Scanner v4 PWA (`/home/user/workspace/judas-cascade-app`). It turns each surfaced setup into an
actionable, risk-managed plan that mirrors the trading logic the operator already uses — **without
placing any order**. Live execution stays locked; everything is read-only and in-memory.

App type: vanilla JS / Express PWA (`server.js` + `scanner.js` + `app.js` + `index.html` + `sw.js`).

---

## 1. What was added

### Status engine — `execStatus(r)` (app.js)
Each setup is classified into one of five states, shown as a colored pill with an action:

| Status | Action | When |
|---|---|---|
| **Execution eligible** | Enter now | 8/8, quality ≥ 45, CUSUM aligned, MTF full, funding clean, price in **ideal** zone |
| **Wait for pullback** | Wait | All aligned but price in **acceptable** zone (small run in favor) |
| **Chase risk** | Wait / skip — do not chase | Price already ran toward TP1 (**chase** zone) |
| **Invalidated** | Avoid — beyond stop | Live price is at/through the stop |
| **Avoid** | Avoid | Not a clean 8/8, weak quality (<45), MTF not full, CUSUM against, or funding against |

Precedence: **Invalidated > Avoid > Chase risk > Wait > Eligible** (`EXEC_STATUS_META` maps codes to
label / css class / action / icon).

### Entry validation — `favorR`, `pastStopR`, `entryZone`
- `favorR(r)` = signed R-multiple of current mark vs entry (+ = moved toward target).
- `pastStopR(r)` = distance past the stop in R (≥0 ⇒ invalidated).
- `entryZone(r)` returns **ideal / acceptable / chase / invalidated**:
  - `invalidated` if price is beyond the stop.
  - `ideal` if `favorR ≤ 0.05 and > -0.85` — at/near entry or a healthy pullback against the trade
    (better price, same stop). Symmetric for LONG (pullback) and SHORT (bounce).
  - `acceptable` if `favorR ≤ 0.35` (small run in favor).
  - `chase` otherwise (ran a fair bit — poor RR to chase).
- UI shows current price, **price delta % from entry** (above/below), **R in favor/against**, and a
  visual zone meter (`.exmeter`) with ideal/acceptable/chase bands and a position marker.

### Position sizing — `positionSizing(r)` (in-memory only)
Inputs from the **Account & Risk** settings group (held on `params.*`, **never persisted**):
- `account_size`, `risk_pct`, and the new **`max_leverage`** (default 10; `0` = no cap).

Outputs per setup: **risk amount** (`acct·risk%`), **stop distance** (price + %), **suggested size**
(units = riskAmt / stopDist) and **notional** (units · entry), **leverage caution**
(`reqLev = notional/acct`; flags when it exceeds the cap), and **max loss if SL hits** (= risk amount).
If account/risk are unset it shows a note prompting the operator to fill them in (kept in memory only).

### Execution plan levels — `execPlan(r)`
- **Entry plan** chosen by proximity zone (limit near entry / wait for retrace / do-not-chase / no entry).
- **SL** with % risk.
- **TP1 at 1R** (entry ± one stop distance) with `+%` and **book %**.
- **TP2 / final at the configured RR** (uses the setup's `rr`, else `rr_target`) with `+%` and book %.
- **Trail remainder** after TP1 toward the final R.
- **Break-even rule**: move SL to entry after TP1 fills (or after price holds +1R).
- **Partial booking** split driven by the new **`tp1_book_pct`** param (default **50**; TP2 books the
  remainder). Adjustable and displayed on every card and in copied/Telegram plans.

### Invalidation checklist — `invalidationList(r)`
Five hard conditions, exit if any trigger: gate score drops below 8/8 on the next scan; price closes
beyond SL; CUSUM regime flips opposite the setup; MTF agreement drops below full; funding / regime
turns against.

### Trade-management timeline — `tradeTimeline(r, plan)`
Five steps: **Pre-entry checks → Entry trigger → TP1 / BE move → Final TP / trailing exit → Forced
exit conditions**.

### Confidence / risk warning
Every panel and every copied/Telegram plan includes, verbatim:
> **Technical setup only — not financial advice. Follow risk size and SL.**
No profit is promised; the panel emphasizes risk size, SL and invalidation.

### Telegram message upgrade
`app.js` attaches `exec: execSummary(r)` to both the **manual** "Send latest 8/8 setup" payload and the
**auto-send** payload. `server.js` `buildTelegramMessage` renders an **Execution plan** block: status,
action + entry type, current price (and Δ% vs entry), TP1 (1R) and TP2 (final R) with book %, SL risk %,
BE rule, sizing line (only when account/risk are set), and up to six invalidation bullets — all
HTML-sanitized via `tgEscape`. Auto-send still fires **only when the existing toggle is armed**.

### Copy "Execution Plan" button — per setup
`copyExecPlan(r, btn)` copies the plain-text plan (`plainExecPlan(r)`) via the existing `copyText`
clipboard helper (with fallbacks), and flashes "✓ Copied" on the button.

---

## 2. Files changed

| File | Change |
|---|---|
| `scanner.js` | `analyze()` returns `price`, `mark` (live mark or last close), `entryDeltaPct`. |
| `server.js` | `buildTelegramMessage` renders the optional `setup.exec` execution-plan block; footer disclaimer reinforced. |
| `app.js` | Added the execution engine (`favorR`, `pastStopR`, `entryZone`, `execStatus`, `EXEC_STATUS_META`, `positionSizing`, `execPlan`, `invalidationList`, `tradeTimeline`, `execSummary`) and UI helpers (`execIcon`, `executionPanelHTML`, `plainExecPlan`, `copyExecPlan`); wired the panel into `cardHTML`, the `copyexec` action into `bindCardActions`, and `exec` into both Telegram payloads; added `max_leverage` + `tp1_book_pct` to the Account & Risk param group; `normalizeRow`/`evalSymbol` pass through `mark`/`entryDeltaPct`. |
| `index.html` | Added `.expanel` + `.ex*` CSS (status pill, entry-zone meter, plan/sizing 2-col grid, timeline, invalidation list, disclaimer, copy action), using existing theme vars; grid collapses to 1 column below 520px; no horizontal overflow at 375/390px. |
| `sw.js` | Cache bumped `delta-v4-4` → `delta-v4-5`. |
| `HANDOFF.md` | Added "Execution Strategy upgrade" section + file-table rows. |

---

## 3. Safety preserved

- **No real orders** from browser or backend; **live execution stays locked**.
- **No secrets in the frontend.**
- **No `localStorage` / `sessionStorage` / `indexedDB` / cookies** — all execution state and sizing
  inputs are in-memory on `params.*` / `state.*` (verified empty in QA).
- Auto Watch / auto-send remain in-app only and only run while the tab is open and the toggle is armed.

---

## 4. Tests run

- `node --check server.js && node --check scanner.js && node --check app.js && node --check sw.js` — all pass.
- `node server.js` (PORT 8000, binds 0.0.0.0):
  - `GET /api/health` → `{ ok: true, data_source: "LIVE DELTA PUBLIC DATA", delta_reachable: true }`.
  - `POST /api/scan` (`{}`) → live results; response carries `price` / `mark` / `entryDeltaPct` fields.
- Playwright mobile QA at **390×844**:
  - Manual scan renders **12 cards → 12 execution panels**.
  - Panel shows status pill, action, entry-zone meter + label, full plan (Entry, SL, TP1 1R, TP2 2R,
    BE, Trail), position sizing, **5** timeline steps, **5** invalidation items, disclaimer, copy button.
  - **Position-sizing calculator updates**: changing account to $5000 / risk to 2% → "Risk amount $100.00".
  - **Copy Execution Plan** works (button flips to "✓ Copied").
  - **Alerts view** renders (Telegram card present).
  - **No console errors**; **no horizontal overflow** (`scrollWidth == innerWidth == 390`).
  - **No browser storage**: `localStorage.length == 0`, `sessionStorage.length == 0`, `document.cookie == ""`.
  - Screenshot: `qa-exec-panel-mobile.png`.

---

## 5. Run / deploy

- **Start:** `cd /home/user/workspace/judas-cascade-app && node server.js` (or `npm start`). PORT 8000,
  binds 0.0.0.0. Telegram calls need `api_credentials=["external-tools"]` in the run environment.
- **Deploy:** `deploy_website(project_path="/home/user/workspace/judas-cascade-app", entry_point="index.html")`.
  `app.js` uses the `__PORT_8000__` placeholder that `deploy_website` rewrites to the proxy path.

---

## 6. Limitations

- `mark` / `entryDeltaPct` come from the Delta ticker at scan time — they are **not streamed**; re-run a
  scan (or Auto Watch) to refresh live price vs entry. In DEMO fallback, `mark` is synthesized as a
  deterministic drift from entry so the panel still demonstrates all states.
- Execution plans are **decision support only** — no orders are placed; tick/lot rounding and exchange
  minimums are not enforced. The operator must size and place trades manually on the exchange.
- Position sizing assumes linear (USDT-margined) contracts where notional ≈ units · entry; exotic
  contract multipliers are not modeled.
- Sizing inputs are in-memory by design and reset on reload (per the "no localStorage" requirement).
