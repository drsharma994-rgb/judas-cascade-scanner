# Delta Scanner v4 — Strategy Match + Solid-Only Layer · Handoff

This upgrade adds a **Strategy Match** decision overlay on top of the existing strict 8-gate
scanner. It converts each raw 8/8 setup into an assistant-style trade decision — a rule-based
grade, an action, a size multiplier, and reason chips — **without removing or altering the raw
scanner output**. It also enforces the user's **"solid-only" rules** (keep proven/non-circular
signals, drop unproven/circular ones) and renames the quality metric so it can never be read as a
probability or win rate.

Edit the existing app in `/home/user/workspace/judas-cascade-app` — vanilla JS PWA + Node/Express
backend. **Not** the React fullstack template.

---

## What's new

### 1. Strategy Match engine (`app.js`)
- `strategyMatch(r)` — deterministic, rule-based evaluation per setup. Returns:
  `grade` (A+ / A / B / NO TRADE), `action`, `why`, `zone`, `q` (Setup Quality), `sizeMult`,
  `sizeNote`, `meta`, `chips`, `topReasons`, plus boolean flags
  (`fam4`, `fam3`, `fundingMixed`, `fundingAgainst`, `rsiExhausted`, `stopWide`, `regimeMixed`,
  `cusumAligned`, `mtfFull`).
- **Grade rules (strict precedence):**
  - **A+** — 8/8, MTF full, CUSUM aligned, Setup Quality ≥ 75, ideal/acceptable zone, RR ≥ 2,
    stop not wide, funding not against, regime not flat, Fam 4/4 (Fam 3/4 allowed **only** if
    quality ≥ 75 AND zone ideal).
  - **A** — 8/8, quality ≥ 60, not chase, RR ≥ 1.8, MTF full, CUSUM aligned. Downgraded to B on
    Fam 3/4 with mid quality / non-ideal zone.
  - **B** — 8/8 but reduced (Fam 3/4, quality 45–59, acceptable-not-ideal, or mixed market/funding)
    → wait for retest.
  - **NO TRADE** — chase, invalidated, quality < 45, gate < 8, CUSUM/MTF mismatch, regime against,
    or RSI exhausted.
- **Actions (exact wording):** `Enter now with partial size`, `Wait for pullback/retest`,
  `Avoid / setup invalidated`, `Do not chase`.
- **Size multiplier:** A+ ideal = 1.00×; A ideal = 0.75×, A acceptable = 0.50×; A+ acceptable =
  0.75×; B = 0.25× max (paper preferred); No Trade = 0×. Reduced further on Fam 3/4, funding mixed,
  wide stop, chase, or mixed regime.
- **Reason chips:** positive (8/8 confirmed, MTF n/n, CUSUM aligned, Judas yes, price near entry,
  RR ≥ 2 / ≥ 1.8, Fam 4/4) and cautionary (gate n/8, MTF mismatch, regime mixed/against, no Judas,
  wait for retest, chase risk, invalidated, Fam only 3/4, funding mixed/against, RSI exhausted,
  stop wide).
- `STRATEGY_PROFILES`, `GRADE_ORDER`, `GRADE_META`, `gradeAtLeast()`, `activeProfile()`,
  `strategyCompare()` support sorting, filtering, and auto-send gating.

### 2. Strategy Match panel per setup card (`app.js` `strategyPanelHTML`, `index.html` CSS)
- Renders inside every card **above** the (renamed) Setup Quality panel and Execution panel.
- Shows grade badge, tag, active profile, action, size bar + note, reason chips (teal = positive,
  amber = cautionary), and a "Rule-based checklist — not a probability, win rate, or financial
  advice" footer.
- A compact grade badge (`.gradebadge`) is also added to the card header row.

### 3. Setup Quality rename (was "Quality Score")
- Panel title is now **"Setup Quality"** with subtitle **"checklist score · not a probability or
  win rate"**. The score is explicitly a checklist read, not a probability or win rate.

### 4. Strategy profile control + explainer cards (Settings view)
- New **Strategy profile** segmented control: **Balanced / Strict Assistant / Ultra Strict**,
  default **Strict Assistant** (`state.strategyProfile = "strict"`).
  - Balanced: shows A+/A/B; auto-send A and above.
  - Strict Assistant (default): A+/A focus, B shown as watch-only; auto-send A and above.
  - Ultra Strict: only A+/A surface (No-Trade dropped), Fam 4/4 preferred; auto-send A+ only.
  - Profile drives **sorting, visibility filtering, badges, and the minimum Telegram auto-send
    grade**. The minimum auto-send grade is shown in the profile note.
- **"My logic — how I read a setup"** card: no blind entry (check price/spread/scan-valid/BTC
  regime/risk), partial entry first, TP1 at 1R + SL to BE, let the rest run to final TP, wait/stand
  aside when not ideal. Includes a "technical setup only — not financial advice" disclaimer.
- **"Solid-only strategy rules"** card (`What this strategy keeps/drops`):
  - **Keeps:** Funding > 0.3% block (real crowding, proven); RSI exhaustion block (established,
    non-circular); EMA cross for trend (simple/reliable); MTF cascade 4h/1h/15m/5m (strongest
    alignment filter); Judas / Asian range (liquidity grab sound); Delta India API only (only
    reliable source in India).
  - **Drops:** Confidence % formula (circular, relabels 4/4); AI ensemble score (no backtest,
    hand-picked weights); Win-rate labels (no real sample); 10+ competing signal layers (contradict
    each other).
  - **Alert rule** callout: *"Fire an alert when the MTF cascade is 4/4 + Judas confirmed + funding
    clean + RSI not exhausted — and log every outcome."*
  - **MTF note:** target is 4h/1h/15m/5m; the current scanner uses the available configured
    timeframes (default 4h/1h/15m). A 3/3 alignment is kept and labelled accordingly rather than
    inflated.

### 5. Sorting / filtering by grade (`render()` + `applyProfileView()`)
- Cards and the Passed view are sorted **A+ > A > B > No Trade**, then by Setup Quality.
- Profile filters visibility (Ultra Strict hides No-Trade; others keep them at the bottom).
- **Raw 8/8 report is preserved exactly** — `reportKept` is always the full unfiltered passed list,
  never touched by the Strategy Match overlay. Heat / dedup / nav counts use the full passed set.

### 6. Telegram payload + message (`app.js` + `server.js`)
- `strategyPayload(r)` adds `{ grade, action, sizeNote, sizeMult, profile, topReasons }` to both the
  manual `tgSend("setup")` payload and the `tgAutoSendSetup` auto-send payload.
- `server.js` `buildTelegramMessage()` renders a **— Strategy Match —** block (grade · profile,
  action, size, top reasons) before the execution block, all HTML-escaped via `tgEscape`. Footer
  reads "Rule-based checklist — not a probability or win rate." **No AI / probability / win-rate
  labels** appear in the message.
- Copy-setup text (`plainSetup`) now leads with the Strategy Match grade/action/size and uses
  "Setup Quality … checklist score" wording.

### 7. Auto-send respects minimum strategy grade (`tgAutoProcess`)
- Auto Watch auto-send now filters NEW setups to those meeting the active profile's `minAuto`
  (default **A**; Ultra Strict = **A+**), sorted by `strategyCompare`. Dedup (`sentKeys`) preserved.
  Auto-send remains in-app only, session-only, default OFF.

### 8. Service worker cache bumped
- `sw.js` `CACHE` bumped `delta-v4-5` → `delta-v4-6` so clients pick up the new UI.

---

## Screenshot "solid-only" rules — matched

All rules from the follow-up screenshots are implemented:

| Screenshot rule | Status |
|---|---|
| Add "Solid-only strategy rules" / "What this strategy keeps/drops" card | ✅ Settings view |
| KEEP: funding > 0.3% block, RSI exhaustion, EMA cross, MTF cascade 4h/1h/15m/5m, Judas/Asian range, Delta India API only | ✅ verbatim in Keeps column |
| DROP: confidence % formula, AI ensemble score, win-rate labels, 10+ competing signal layers | ✅ verbatim in Drops column |
| Avoid "confidence %" / "win rate"; rename Quality Score → "Setup Quality"/checklist score | ✅ renamed + subtitle "not a probability or win rate"; no such labels in UI/Telegram |
| Alert rule: MTF 4/4 + Judas + funding clean + RSI not exhausted, log every outcome | ✅ alert-rule callout |
| MTF 3/3 kept but labelled "4h/1h/15m/5m target; uses configured timeframes" | ✅ MTF note in card |
| Telegram/auto-send respects solid-only (no AI/probability/win-rate; grades stay A+/A/B/No Trade as rule-based checklist) | ✅ server + payload |

The only places the strings "confidence %" / "win-rate" appear are the **Drops** list (naming them
as dropped) and the disclaimer copy ("not a probability or win rate") — never as a live metric.

---

## Files changed

- `app.js` — Strategy Match engine, panels, `renderStrategy()`, profile state, render
  sorting/filtering + raw-report preservation, `strategyPayload()`, Telegram payload + auto-send
  grade gate, `plainSetup` rewording. (~+260 lines)
- `index.html` — Strategy Match panel CSS, grade-badge CSS, `qtitle` CSS, strategy-settings card
  CSS, `#strategyRoot` container + "Strategy Match" section in Settings view.
- `server.js` — `buildTelegramMessage()` Strategy Match block.
- `sw.js` — cache version bump.

## Tests run

- `node --check` on `server.js`, `scanner.js`, `app.js`, `sw.js` — all pass.
- Server started with `PORT=8000 node server.js` (external-tools creds): `GET /api/health` → ok,
  `delta_reachable:true`, LIVE data; `POST /api/scan` → ok, live results.
- Playwright mobile QA at 375px: scan runs; Strategy Match panel + grade badge render; **zero
  console errors; zero horizontal overflow**. Settings view shows the profile control (default
  Strict Assistant), My-logic card, and Keep/Drop card with alert rule. Profile switch to Ultra
  Strict updates the note and min auto-send grade with no errors.
- Screenshots saved: `qa-strategy-scan-mobile.png`, `qa-strategy-settings-mobile.png`.

## Run / deploy

```bash
cd /home/user/workspace/judas-cascade-app
PORT=8000 node server.js     # start with api_credentials=["external-tools"] for Telegram
# open http://localhost:8000/ ; GET /api/health ; POST /api/scan
```

Deploy the directory with `deploy_website` (entry `index.html`). The backend must run for live
scans + Telegram; the frontend falls back to clearly-labelled DEMO data if the backend/Delta feed
is unreachable.

## Safety (unchanged + reinforced)

- **No real orders** from browser or backend. Live execution stays locked behind the separate
  Python bot. Strategy Match is advisory only.
- **No secrets in the frontend.** Telegram token stays in the backend runtime; Delta calls use
  public endpoints only.
- **No `localStorage` / `sessionStorage` / `indexedDB` / cookies.** All Strategy Match state
  (profile, sent/seen keys) lives in memory and resets each session.
- Auto Watch + auto-send remain in-app only, session-only, default OFF; auto-send now additionally
  gated by minimum strategy grade.
- Strategy Match adds **no new circular metrics** — it reuses existing deterministic helpers
  (`qualityScore`, `entryZone`, `execStatus`, `favorR`) and is explicitly a rule-based checklist,
  not a probability or win rate.

## Limitations

- The grade is a deterministic checklist mapping, not a backtested probability. It is intentionally
  conservative (Strict Assistant default) and never implies an edge or win rate.
- MTF cascade target is 4h/1h/15m/5m but the live scanner uses the configured timeframes (default
  4h/1h/15m → 3/3). This is labelled in the UI rather than inflated to 4/4.
- Backend may serve DEMO data when Delta India is unreachable; grades are computed identically on
  demo data and clearly labelled as DEMO in the UI.
