# Confirmatory Signal Layer — Handoff

A **rule-based, deterministic** layer added to Delta Scanner v4 that runs **after** the strict
8-gate verdict and the Strategy Match grade. It combines technical confirmation, crypto-native
fundamentals, and market regime into a single status and a size-adjustment multiplier.

> **It is never a probability, win-rate, confidence %, or forecast.** It only **confirms**,
> **reduces size**, or **blocks** an already-qualified setup. It **never** edits the raw scanner
> report and **never** scrapes news.

App directory: `/home/user/workspace/judas-cascade-app/` (vanilla Node/Express + vanilla-JS PWA —
not the React template). Start: `npm start` (PORT 8000). Data: live Delta Exchange **India** public
endpoints only; no API secrets; live order execution stays locked.

---

## Four statuses (precedence RED > ORANGE > YELLOW > GREEN)

| Status | Label | Action | Layer multiplier |
|---|---|---|---|
| **GREEN** | Entry allowed | Entry eligible — partial size | 1.00× |
| **YELLOW** | Wait for retest | Wait for retest / confirmation | 0.50× |
| **ORANGE** | Reduce size | Reduce size — mixed context | 0.50× (0.25× if ≥2 mixed flags) |
| **RED** | No trade | No trade — stand aside | 0.00× |

`combinedMult = round(StrategyMatch.sizeMult × layerMult, 2)` — applied *conceptually* after the
Strategy Match multiplier. The size-adjust note shows both, e.g. `0.50× (after Strategy Match 0.75×)`
and a `combined ≈ 0.38×` chip.

### Final-action rule (deterministic)

- **GREEN** requires **all** of: strict `8/8` gate **and** Strategy Match `A`/`A+` **and** BTC regime
  not against (aligned or unavailable) **and** funding not against/crowded **and** volume
  confirms-or-neutral (or unavailable) **and** price near entry/retest (`entryZone === ideal`) **and**
  liquidity acceptable (`ok`/`moderate`/unavailable).
- **YELLOW** = good but needs a retest, a confirming piece is neutral/unavailable, or Strategy Match is
  below `A`. **Missing data alone never blocks** (it degrades to YELLOW, not RED).
- **ORANGE** = valid but mixed: BTC against, BTC mixed/flat, VWAP against, weak volume, thin liquidity,
  wide stop, or funding mixed.
- **RED** = Strategy `NO TRADE`, setup invalidated, gate `< 8/8`, CUSUM/MTF mismatch, BTC strongly
  against, funding against/crowded, or severe chase.

---

## Eight components (each → `pos` / `neg` / `warn` / `na`)

| Component | Source | States |
|---|---|---|
| **BTC / market regime** | `state.marketRegime` (CUSUM on BTC/ETH candles, per scan) | aligned / against / against-strong (strength ≥ 1.6) / mixed (FLAT) / unavailable. Graceful "BTC regime n/a" — never blocks on missing data alone. |
| **Funding pressure** | `r.fund` (% on Delta India) | supports / clean / crowded (\|fund\| > 0.3%) / against / unavailable. Keeps the >0.3% crowding block. |
| **Open interest** | `r.oi` from Delta ticker (`oi`/`open_interest`/`oi_value_usd`/`oi_contracts`) | present / unavailable. **Never fabricates a rising/falling direction** without a historical series. |
| **Volume confirmation** | `r.volRatio` (last vs average) | spike (≥1.5) / expansion (≥1.1) / neutral (≥0.8) / weak / unavailable. |
| **VWAP / EMA location** | `r.vwapLoc \|\| r.emaLoc` | aligned (long above / short below) / against / unavailable. |
| **Judas / retest** | `entryZone(r)` | entry (ideal) / retest (acceptable) / chase / invalidated. |
| **Liquidity quality** | `r.liqQuality` (turnover proxy: ok ≥ 5e6, moderate ≥ 1e6, else thin) | ok / moderate / thin / unavailable. Delta India API only. |
| **Event / news risk** | placeholder | **always** "manual check" (`warn`). **No web-scraping in this upgrade.** |

Reason chips sort `pos < neg < warn < na`; `topReasons` = first 7 non-`na` chips (used in copy + Telegram).

---

## Files changed

| File | Change |
|---|---|
| `scanner.js` | Added `volumeRatio()` and `vwapLast(candles,n=20)` helpers. Enriched `analyze()` to return `oi`, `oiUsd`, `volRatio`, `vwap`, `vwapLoc`, `ema50`, `emaLoc`, `liqQuality`. Added + exported `marketRegime(client,cfg)` (CUSUM BTC/ETH regime → `{available, tf, bias UP/DOWN/FLAT, strength, btc, eth}` or `{available:false}`). |
| `server.js` | Imports `marketRegime`; `/api/scan` calls it in non-fatal try/catch and returns `market_regime`. `buildTelegramMessage()` renders a **Confirmatory layer** block (status / action / size adj / confirms) after the Strategy Match block and before the Execution plan. |
| `app.js` | `state.marketRegime`; regime captured in `fetchScan()` (backend + demo) and `runScan()`; confirmatory fields added to `normalizeRow()` and demo synthesis in `evalSymbol()`; `demoRegime()`. Full engine: `CONFIRM_META`, `CONFIRM_ORDER`, 8 component fns, `confirmatory(r)`, `confirmAtLeast()`, `confirmatoryPanelHTML(r)` (inserted between Strategy Match and Setup Quality). `confirmPayload(r)` added to manual (`tgSend`) and auto (`tgAutoSendSetup`) payloads. `tgAutoProcess()` auto-send gate. Confirmatory line in `plainSetup(r)`. Confirmatory explainer card in `renderStrategy()`. |
| `index.html` | New CSS block: `.cfpanel` (+ `.ok/.warn/.warn2/.bad`), `.cftitle`, `.cfhead`, `.cfstatus`, `.cfaction`, `.cfsize`, `.cfk`, `.cfv` (+ `.pos/.neg/.warn/.na`), `.cfcombined`, `.cfgrid`, `.cfrow`, `.cfchips`, `.cfchip` (+ kinds), `.cfwhy`. ORANGE uses a distinct orange `#ff8a3d` to separate it from YELLOW/amber. |
| `sw.js` | Cache version `delta-v4-6` → `delta-v4-7`. |
| `HANDOFF.md` | Added a Confirmatory Signal Layer upgrade section. |

---

## Telegram & copy

- **Payload:** `setup.confirm = { statusLabel, action, sizeNote, combinedMult, topReasons }` is included
  in **both** the manual "Send latest 8/8 setup" path (`tgSend("setup")`) and the in-app auto-send path
  (`tgAutoSendSetup`).
- **Server message:** `buildTelegramMessage()` renders the block as `Status / Action / Size adj /
  Confirms: …` with the disclaimer *"Confirms/reduces after 8/8 + Strategy Match — not a prediction engine."*
- **Copy setup** (`plainSetup`) includes a `Confirmatory:` line and a `Confirm checks:` line.
- **Auto-send gate** (`tgAutoProcess`), deterministic, no probability:
  - **Never** auto-sends Strategy `NO TRADE` or confirmatory `RED`.
  - Auto-sends **only** `GREEN` or `YELLOW` that also clear the profile's minimum grade (`A`/`A+`).
  - `ORANGE` is **excluded from auto-send** — manual-only (an ORANGE + Balanced profile setup can be
    sent by the user with the manual button, never automatically).

---

## Settings explainer

A "Confirmatory Signal Layer" card in the Settings → Strategy view (`renderStrategy()`, `#strategyRoot`)
states the layer **only confirms or reduces/blocks after 8/8 + Strategy Match and is not a prediction
engine**, lists the four colour-coded statuses with their rules, and names the crypto-native
fundamentals it uses — **liquidity, funding, open interest, BTC dominance / market regime, event/news
risk** — explicitly noting **no fake equity-style fundamentals, no fabricated OI direction, no scraped
news.**

---

## Safety (preserved)

- No real orders; live execution remains locked server-side.
- No secrets in the frontend.
- **No** `localStorage` / `sessionStorage` / `indexedDB` / cookies — all state in memory; Auto Watch is
  in-app only.
- **Raw scanner report preserved byte-for-byte** — the confirmatory layer is presentation/overlay only
  and is never injected into the report string.
- Mobile-first, PWA installable.

---

## Tests run

- `node --check server.js scanner.js app.js sw.js` → all **pass**.
- Server started (`PORT=8000 node server.js`, `external-tools` creds for the Telegram path).
  - `GET /api/health` → `ok:true`, `delta_reachable:true`.
  - `POST /api/scan {max_symbols:8}` → returns `market_regime` (`available:true, bias:DOWN`, BTC/ETH
    CUSUM) and per-row confirmatory fields (`oi`, `oiUsd`, `volRatio`, `vwap`, `vwapLoc`, `emaLoc`,
    `ema50`, `liqQuality`).
  - `POST /api/scan {max_symbols:100}` → surfaced real strict 8/8 setups; **raw report contains no
    "Confirmatory" text** (report integrity confirmed).
  - `POST /api/telegram/alert` with a synthetic GREEN setup → `connector:true`, send path executed
    (deliberately invalid chat id returned Telegram `400 chat not found`; **no real message delivered**),
    confirming the server renders + submits the confirmatory block.
- Playwright mobile QA (390px):
  - Scan runs; **12/12 cards render a confirmatory panel**; panel order verified
    `strategy → confirmatory → quality → execution`.
  - Component grid renders all 8 reads with correct `pos/neg/warn/na` colouring on live data (e.g. a
    LONG correctly RED via "BTC strongly against"; a SHORT 8/8 correctly RED via severe "chase risk").
  - Settings "Confirmatory Signal Layer" explainer card renders with all four statuses + fundamentals.
  - Manual "Send latest 8/8 setup" payload captured → `setup.confirm` present with `statusLabel`,
    `action`, `sizeNote`, `combinedMult`, `topReasons`.
  - **No horizontal overflow** (`scrollWidth == clientWidth == 390`); confirmatory panel fits the
    viewport; **zero real console errors** (the only logged error was the intentional aborted
    `/api/scan` route used to exercise demo fallback).
  - Screenshot: `qa-confirmatory-mobile.png`.

## Start / deploy

```bash
cd /home/user/workspace/judas-cascade-app
npm start            # node server.js, PORT 8000 (set external-tools creds for Telegram)
# deploy: deploy_website(project_path="/home/user/workspace/judas-cascade-app")
```

## Limitations

- **Open interest is presence-only.** Without a historical OI series the layer reports OI as neutral
  context and never claims rising/falling — by design (no fabrication).
- **Market regime is a coarse CUSUM** on BTC/ETH candles for the current timeframe; if BTC/ETH candles
  are unavailable it returns `{available:false}` and the regime component degrades to YELLOW-eligible
  "n/a" rather than blocking.
- **Event/news risk is a manual placeholder only** — no scraping in this upgrade.
- The confirmatory size multiplier set actually used is `1.0 / 0.5 / 0.25 / 0` (the documented 0.75
  tier is reserved; the deterministic rules currently resolve to those four values).
- Live data only via Delta India public endpoints; demo mode is clearly labelled when the backend is
  unreachable.

Nothing here is financial advice.
