/* Delta Scanner v6 — 4-Family · Structural-First · Measured (Judas Cascade)
 * Mobile dashboard front-end. Mirrors judas_8gate_bot.py parameters,
 * gate order, and the exact terminal output format.
 *
 * Live data is NOT available from static hosting, so this build ships a
 * deterministic demo engine clearly labelled as preview data. The fetch
 * path (fetchScan) is wired so a backend exposing /api/scan can replace
 * the demo engine with one flag — no UI changes required.
 */
(function () {
  "use strict";

  /* ---------- gate definitions (fixed order, mirrors GATE_LABELS) ---------- */
  const GATES = [
    { key: "FAMILY_QUALITY",  label: "Family Quality" },
    { key: "MTF_CASCADE",     label: "MTF Cascade" },
    { key: "RSI_CLEAN",       label: "RSI Clean" },
    { key: "FUNDING_CLEAN",   label: "Funding Clean" },
    { key: "JUDAS_SWEEP",     label: "Judas Sweep" },
    { key: "CUSUM_ALIGN",     label: "CUSUM Align" },
    { key: "STRUCTURAL_RR_SL", label: "Structural RR/SL" },
    { key: "LIQUIDITY_PRICE", label: "Liquidity / Price" },
  ];

  /* ---------- parameter schema (mirrors JudasConfig env vars) ---------- */
  // groups -> fields. type: num|sel|txt
  const PARAM_GROUPS = [
    { title: "Account & Risk", icon: "$", fields: [
      { id: "account_size", label: "Account size", type: "num", val: 1000, step: 100, hint: "for $ position sizing (in-memory only)" },
      { id: "risk_pct", label: "Risk per trade %", type: "num", val: 1, step: 0.25, hint: "$ risk = size × this" },
      { id: "max_leverage", label: "Max leverage cap", type: "num", val: 10, step: 1, hint: "0 = no cap · caution flag if notional needs more" },
      { id: "tp1_book_pct", label: "Book % at TP1 (1R)", type: "num", val: 50, step: 5, hint: "partial booking; rest to final TP" },
    ]},
    { title: "RSI", icon: "~", fields: [
      { id: "rsi_hi", label: "RSI overbought", type: "num", val: 65, step: 1, hint: "upper exhaustion bound" },
      { id: "rsi_lo", label: "RSI oversold", type: "num", val: 35, step: 1, hint: "lower exhaustion bound" },
      { id: "rsi_adapt", label: "RSI adapt mode", type: "sel", val: "trend", opts: [["trend","By trend (50 EMA)"],["fixed","Fixed"]] },
    ]},
    { title: "Funding", icon: "%", fields: [
      { id: "funding_block_pct", label: "Funding block ±%", type: "num", val: 0.05, step: 0.01, hint: "|funding| clean rule" },
      { id: "funding_mult", label: "Funding mult", type: "num", val: 1, step: 1, hint: "Delta India ships %, so 1" },
    ]},
    { title: "ATR / Stop", icon: "^", fields: [
      { id: "atr_mult", label: "ATR stop mult", type: "num", val: 1.5, step: 0.1, hint: "ATR × this = base stop" },
      { id: "atr_dynamic", label: "Dynamic ATR", type: "sel", val: "vol", opts: [["vol","Vol-scaled"],["fixed","Fixed"]] },
    ]},
    { title: "EMA Cascade", icon: "/", fields: [
      { id: "ema_fast", label: "EMA fast", type: "num", val: 9, step: 1 },
      { id: "ema_slow", label: "EMA slow", type: "num", val: 21, step: 1 },
      { id: "ema50_stretch_pct", label: "EMA50 stretch %", type: "num", val: 8, step: 1, hint: "context warning" },
    ]},
    { title: "Timeframes & Judas", icon: "#", fields: [
      { id: "entry_tf", label: "Entry timeframe", type: "sel", val: "15m", opts: [["15m","15m"],["5m","5m"]] },
      { id: "mtf_timeframes", label: "MTF timeframes", type: "txt", val: "4h,1h,15m", hint: "must all agree (MTF:n/n)" },
      { id: "judas_mode", label: "Judas mode", type: "sel", val: "asian", opts: [["asian","Asian window"],["range","Range"]] },
      { id: "asian_start", label: "Asian start UTC", type: "num", val: 0, step: 1 },
      { id: "asian_end", label: "Asian end UTC", type: "num", val: 6, step: 1 },
    ]},
    { title: "Reward", icon: "=", fields: [
      { id: "rr_target", label: "RR target", type: "num", val: 2, step: 0.5, hint: "reward:risk floor" },
      { id: "rr_dynamic", label: "Dynamic RR", type: "sel", val: "fixed", opts: [["fixed","Fixed"],["vol","Vol-scaled"]] },
    ]},
    { title: "Promotable Context", icon: "*", fields: [
      { id: "vol_exhaustion", label: "Volume exhaustion", type: "sel", val: "context", opts: [["context","Context"],["require","Require (gate)"]] },
      { id: "macd_divergence", label: "MACD divergence", type: "sel", val: "context", opts: [["context","Context"],["require","Require (gate)"]] },
      { id: "bb_position", label: "Bollinger position", type: "sel", val: "context", opts: [["context","Context"],["require","Require (gate)"]] },
    ]},
    { title: "Universe Filters", icon: "@", fields: [
      { id: "quote_filter", label: "Quote filter", type: "sel", val: "", opts: [["","Any"],["USD","USD"],["USDT","USDT"]] },
      { id: "min_turnover", label: "Min 24h turnover", type: "num", val: 0, step: 100000, hint: "0 = no floor" },
      { id: "max_symbols", label: "Max symbols", type: "num", val: 1000, step: 50, hint: "full Delta futures universe by default; lower only if scan is too slow" },
      { id: "concurrency", label: "Concurrency", type: "num", val: 8, step: 1, hint: "parallel workers" },
    ]},
    { title: "Quality Gate", icon: "+", fields: [
      { id: "family_score_floor", label: "Family score floor", type: "num", val: 75, step: 1, hint: "/100 (4 families)" },
      { id: "cusum_threshold", label: "CUSUM threshold", type: "num", val: 1.0, step: 0.1, hint: "std units" },
    ]},
    { title: "Connectivity", icon: ">", fields: [
      { id: "cors_proxy", label: "CORS proxy prefix", type: "txt", val: "", hint: "optional if host blocks Delta" },
    ]},
  ];

  const params = {};
  PARAM_GROUPS.forEach(g => g.fields.forEach(f => { params[f.id] = f.val; }));

  /* ---------- state ---------- */
  const state = {
    strict: true,
    strategyProfile: "strict",   // balanced | strict | ultra (default Strict Assistant)
    mode: "scan",            // scan | paper | testnet | live
    liveApiKeyConfigured: false,   // simulated; never a real secret
    liveRiskAck: false,
    auto: false,
    autoTimer: null,
    // ----- Auto Watch (in-app repeated scans; no background scheduler) -----
    aw: {
      on: false,
      intervalSec: 300,      // selected interval (default 5m)
      tickTimer: null,       // 1s countdown ticker
      remaining: 0,          // seconds until next scan
      count: 0,              // completed Auto Watch scans this session
      lastScanAt: "",        // UTC HH:MM of last completed scan
      status: "Idle",        // Idle | Scanning | Waiting
      scanning: false,       // a scan is currently in flight
    },
    // ----- directional-bias proxy (session scanner-memory only; NOT PnL) -----
    // symbol -> { scans, longSignals, shortSignals } accumulated across scans
    // this session. Used as a lightweight persistence proxy for the edge score.
    biasHistory: new Map(),
    // ----- duplicate-alert protection (session memory only) -----
    seenKeys: new Set(),     // setup keys ever surfaced this session
    sentKeys: new Set(),     // setup keys already sent to Telegram this session
    // ----- optional in-app Telegram auto-send (default OFF, session only) ---
    tgAutoSend: false,
    results: [],             // last scan results (all evaluated)
    marketRegime: null,      // confirmatory BTC/ETH regime from last scan (or null)
    lastScanAt: 0,           // ms timestamp of last scan (for setup-validity age)
    alerts: [],
    dataLive: false,         // true once a live backend scan succeeds
    backendNote: "",         // last backend message / fallback reason
    lastReport: "",          // exact terminal report string from last scan
    tgConnector: null,       // null=unknown, true=available, false=unavailable
    tgChats: [],             // last loaded chat list
    tgBusy: false,           // a send/load is in flight
  };

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------- deterministic PRNG so demo data is stable per symbol ---------- */
  function hash(str) { let h = 2166136261 >>> 0; for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /* ---------- demo universe ---------- */
  const SYMBOLS = ["BTCUSD","ETHUSD","SOLUSD","XRPUSD","BNBUSD","DOGEUSD","ADAUSD","AVAXUSD",
    "LINKUSD","MATICUSD","DOTUSD","LTCUSD","TRXUSD","ATOMUSD","NEARUSD","APTUSD","ARBUSD","OPUSD",
    "SUIUSD","INJUSD","TIAUSD","SEIUSD","RNDRUSD","FILUSD","MUSD"];
  const BASE_PX = {BTCUSD:67250, ETHUSD:3520, SOLUSD:172, XRPUSD:0.612, BNBUSD:598, DOGEUSD:0.158,
    ADAUSD:0.448, AVAXUSD:35.2, LINKUSD:16.8, MATICUSD:0.71, DOTUSD:7.15, LTCUSD:84.3, TRXUSD:0.121,
    ATOMUSD:9.4, NEARUSD:6.1, APTUSD:8.9, ARBUSD:1.12, OPUSD:2.34, SUIUSD:1.18, INJUSD:27.4,
    TIAUSD:9.7, SEIUSD:0.54, RNDRUSD:8.2, FILUSD:5.9, MUSD:2.9397};

  function fmtPrice(p) {
    if (p == null) return "—";
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
  }

  /* ---------- duplicate-alert protection ---------- *
   * A setup key is symbol + side + rounded entry/SL/TP + gate score. Two scans
   * that surface the "same" setup (same levels to a sensible precision) collapse
   * to one key, so Auto Watch never logs/sends the same idea twice in a session.
   */
  function roundLevel(v) {
    if (v == null || isNaN(+v)) return "0";
    const a = Math.abs(+v);
    // round to ~4 significant figures so tiny live drift doesn't break dedup
    let dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
    return (+v).toFixed(dp);
  }
  function setupKey(r) {
    return [
      r.sym, r.dir,
      roundLevel(r.entry), roundLevel(r.stop), roundLevel(r.target),
      "g" + (r.score8 || 0),
    ].join("|");
  }
  // State of a setup card relative to session memory: "new" | "seen" | "sent".
  function setupState(r) {
    const k = setupKey(r);
    if (state.sentKeys.has(k)) return "sent";
    if (state.seenKeys.has(k)) return "seen";
    return "new";
  }

  /* ---------- quality score (0-100), distinct from the 8/8 gates ----------
   * Blends the continuous metrics the engine already produces into a single
   * confidence read. Each component is normalized to 0..1, weighted, summed.
   * This is decision-support context only — never a profit promise.
   */
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function qualityComponents(r) {
    const rrTarget = Math.max(1, params.rr_target || 2);
    // RR vs target (capped at 1.6x target)
    const rrN = clamp01(((r.rr || 0) - 1) / (rrTarget * 1.6 - 1));
    // ATR / stop distance: a tighter stop (% of price) is preferred; 0.4%..6% band
    const sl = r.slPct || 0;
    const stopN = sl <= 0 ? 0 : clamp01((6 - Math.min(6, sl)) / (6 - 0.4));
    // 4-family quality /100
    const famN = clamp01((r.score4 || 0) / 100);
    // MTF agreement
    const mtfN = r.nTf ? clamp01((r.mtfAgree || 0) / r.nTf) : 0;
    // funding favorability: closer to zero / on the right side is better
    const block = Math.max(1e-9, params.funding_block_pct || 0.05);
    const fundN = r.fund == null ? 0.5 : clamp01(1 - Math.abs(r.fund) / block);
    // RSI room: distance from the midline toward the exhaustion bound
    let rsiN = 0.5;
    if (Number.isFinite(r.rsi)) {
      if (r.dir === "long") rsiN = clamp01((r.rsi - 50) / 20);
      else if (r.dir === "short") rsiN = clamp01((50 - r.rsi) / 20);
    }
    // CUSUM alignment strength (score in std units, 1..3 maps to 0..1)
    const cusumAligned = (r.cusumDir === "UP" && r.dir === "long") || (r.cusumDir === "DOWN" && r.dir === "short");
    const cusumN = cusumAligned ? clamp01(((r.cusumScore || 1) - 1) / 2) * 0.6 + 0.4 : 0.1;
    // liquidity / turnover (log-scaled; $50k..$200M band)
    const to = Math.max(0, r.turnover || 0);
    const liqN = to <= 0 ? 0 : clamp01((Math.log10(to + 1) - Math.log10(5e4)) / (Math.log10(2e8) - Math.log10(5e4)));
    // volatility compression: tighter stop already proxies this; reuse stopN lightly
    const comps = [
      { key: "RR",     label: "RR",       n: rrN,    w: 0.16 },
      { key: "STOP",   label: "ATR stop", n: stopN,  w: 0.13 },
      { key: "FAM",    label: "Family",   n: famN,   w: 0.18 },
      { key: "MTF",    label: "MTF",      n: mtfN,   w: 0.14 },
      { key: "FUND",   label: "Funding",  n: fundN,  w: 0.10 },
      { key: "RSI",    label: "RSI room", n: rsiN,   w: 0.09 },
      { key: "CUSUM",  label: "CUSUM",    n: cusumN, w: 0.10 },
      { key: "LIQ",    label: "Liquidity",n: liqN,   w: 0.10 },
    ];
    return comps;
  }
  function qualityScore(r) {
    const comps = qualityComponents(r);
    const wsum = comps.reduce((a, c) => a + c.w, 0);
    const s = comps.reduce((a, c) => a + c.n * c.w, 0) / (wsum || 1);
    return Math.round(clamp01(s) * 100);
  }
  // Target confidence label from TP distance vs ATR/RR and overall quality.
  function targetConfidence(r, q) {
    const rrTarget = Math.max(1, params.rr_target || 2);
    const rr = r.rr || 0;
    // Aggressive: stretched TP (far vs risk) or thin quality.
    if (rr >= rrTarget * 1.45 || q < 45) return "Aggressive";
    // Conservative: solid quality and a TP that isn't over-reaching.
    if (q >= 68 && rr <= rrTarget * 1.2) return "Conservative";
    return "Balanced";
  }
  // Expected-move *watch window* text for high-quality 8/8 setups. Describes a
  // monitoring horizon only — never a profit/price promise.
  function expectedWindow(r, q) {
    if (r.score8 !== 8 || q < 70) return "";
    // Scale a rough horizon off the entry timeframe; bigger TF => longer watch.
    const tf = String(params.entry_tf || "15m");
    const hrs = tf === "5m" ? 24 : 48;
    return `${hrs}h breakout watch — monitor for follow-through; not a profit forecast`;
  }
  function qcolor(q) { return q >= 68 ? "var(--long)" : q >= 45 ? "var(--amber)" : "var(--short)"; }

  /* ====================================================================
   * EXECUTION STRATEGY LAYER
   * --------------------------------------------------------------------
   * Matches the crypto trading logic used throughout: enter near the
   * reference entry, avoid chasing once price has run, manage with 1R / final
   * RR targets, move to break-even after TP1, and respect hard invalidation.
   * Everything below is decision-support context only — never a profit promise
   * and never an order. Live execution stays locked.
   * ================================================================== */

  // R-multiple of current price relative to entry, signed in FAVOR of the trade.
  // +1R = price has moved one full stop-distance toward the target.
  function favorR(r) {
    const cur = (Number.isFinite(r.mark) && r.mark > 0) ? r.mark : r.entry;
    const stopDist = Math.abs(r.entry - r.stop) || (r.entry * (r.slPct || 0) / 100);
    if (!stopDist) return 0;
    const favorDir = r.dir === "long" ? 1 : -1;
    return ((cur - r.entry) * favorDir) / stopDist;
  }

  // Distance of current price past the stop, in R (positive = beyond stop).
  function pastStopR(r) {
    const cur = (Number.isFinite(r.mark) && r.mark > 0) ? r.mark : r.entry;
    const stopDist = Math.abs(r.entry - r.stop) || (r.entry * (r.slPct || 0) / 100);
    if (!stopDist) return 0;
    if (r.dir === "long") return (r.stop - cur) / stopDist;   // >0 once below stop
    return (cur - r.stop) / stopDist;                          // >0 once above stop
  }

  // Entry-zone classification by how far current price sits from the reference
  // entry, measured in R (fraction of the stop distance). Symmetric for L/S:
  //   ideal:        small pullback against the trade, or right at entry
  //   acceptable:   minor adverse/favorable drift still inside a sane band
  //   chase:        price already ran in favor — chasing risks a poor RR
  //   invalidated:  price beyond the stop / wrong side of invalidation
  function entryZone(r) {
    const fR = favorR(r);          // + = moved toward target, - = moved against
    const beyond = pastStopR(r);   // + = already past the stop (invalidated)
    if (beyond >= 0) return "invalidated";
    // fR < 0 means price pulled back below entry (long) / bounced above (short)
    // — that is the IDEAL re-entry per the logic (better price, same stop).
    if (fR <= 0.05 && fR > -0.85) return "ideal";          // at/near entry or healthy pullback
    if (fR <= 0.35) return "acceptable";                    // small run in favor — still ok
    if (fR < 0.85) return "chase";                          // ran a fair bit — chase risk
    return "chase";                                         // >0.85R toward TP1 — strong chase
  }

  // Map quality / gate / context signals to an overall execution STATUS.
  // Order of precedence: Invalidated > Avoid > Chase risk > Wait > Eligible.
  function execStatus(r) {
    const q = qualityScore(r);
    const zone = entryZone(r);
    const cusumAligned = (r.cusumDir === "UP" && r.dir === "long") || (r.cusumDir === "DOWN" && r.dir === "short");
    const mtfFull = r.nTf ? (r.mtfAgree / r.nTf) >= 1 : false;
    const block = Math.max(1e-9, params.funding_block_pct || 0.05);
    const fundingAgainst = r.fund != null && (
      (r.dir === "long" && r.fund > block) || (r.dir === "short" && r.fund < -block));

    if (zone === "invalidated") return { code: "invalidated", zone, q };
    // Avoid: not a clean 8/8, weak quality, MTF not fully aligned, CUSUM against,
    // or funding clearly against the trade.
    if (r.score8 < 8 || !cusumAligned || !mtfFull || fundingAgainst || q < 45) {
      return { code: "avoid", zone, q };
    }
    if (zone === "chase") return { code: "chase", zone, q };
    if (zone === "acceptable") return { code: "wait", zone, q };
    return { code: "eligible", zone, q }; // ideal zone + all aligned
  }

  const EXEC_STATUS_META = {
    eligible:    { label: "Execution eligible", cls: "ok",    action: "Enter now", icon: "check" },
    wait:        { label: "Wait for pullback",  cls: "warn",  action: "Wait",      icon: "clock" },
    chase:       { label: "Chase risk",         cls: "warn2", action: "Wait / skip — do not chase", icon: "alert" },
    invalidated: { label: "Invalidated",        cls: "bad",   action: "Avoid — beyond stop", icon: "x" },
    avoid:       { label: "Avoid",              cls: "bad",   action: "Avoid",     icon: "x" },
  };

  // Position sizing from in-memory account inputs (no persistence). Returns a
  // structured object with risk amount, stop distance, qty, notional, leverage
  // caution, and max loss if the stop is hit.
  function positionSizing(r) {
    const acct = Math.max(0, +params.account_size || 0);
    const riskPct = Math.max(0, +params.risk_pct || 0);
    const levCap = Math.max(0, +params.max_leverage || 0);
    const riskAmt = acct * riskPct / 100;
    const stopDist = Math.abs(r.entry - r.stop) || (r.entry * (r.slPct || 0) / 100);
    const qty = stopDist > 0 ? riskAmt / stopDist : 0;          // base units
    const notional = qty * r.entry;                            // $ exposure
    const reqLev = acct > 0 ? notional / acct : 0;             // leverage implied
    let levNote, levOk = true;
    if (levCap > 0 && reqLev > levCap + 1e-9) {
      levOk = false;
      levNote = `needs ${reqLev.toFixed(1)}x > cap ${levCap}x — reduce size or risk %`;
    } else if (reqLev > 0) {
      levNote = `~${reqLev.toFixed(2)}x of equity${levCap ? ` (cap ${levCap}x)` : ""}`;
    } else {
      levNote = "—";
    }
    const maxLoss = riskAmt;                                   // by construction = risk amount
    return {
      acct, riskPct, riskAmt, stopDist, qty, notional, reqLev, levCap, levOk, levNote, maxLoss,
      valid: acct > 0 && riskPct > 0 && stopDist > 0,
    };
  }

  // Execution plan levels: TP1 at 1R, final TP at the configured RR target,
  // SL with % risk, break-even rule and partial booking split.
  function execPlan(r) {
    const stopDist = Math.abs(r.entry - r.stop) || (r.entry * (r.slPct || 0) / 100);
    const favorDir = r.dir === "long" ? 1 : -1;
    const rrTarget = Math.max(1, +params.rr_target || 2);
    const tp1 = r.entry + favorDir * stopDist * 1;             // 1R
    const finalR = (Number.isFinite(r.rr) && r.rr > 0) ? r.rr : rrTarget;
    const tp2 = r.target != null ? r.target : (r.entry + favorDir * stopDist * finalR);
    const tp1Pct = r.entry ? Math.abs(tp1 - r.entry) / r.entry * 100 : 0;
    const tp2Pct = r.entry ? Math.abs(tp2 - r.entry) / r.entry * 100 : 0;
    const tp1Book = Math.min(100, Math.max(0, +params.tp1_book_pct || 50));
    const tp2Book = 100 - tp1Book;
    const zone = entryZone(r);
    const entryType = (zone === "ideal")
      ? `Limit near entry $${fmtPrice(r.entry)} (or market if momentum)`
      : (zone === "acceptable")
        ? `Limit back at $${fmtPrice(r.entry)} — wait for retrace, avoid market chase`
        : (zone === "chase")
          ? `Do not market in — only a limit retrace to ~$${fmtPrice(r.entry)} qualifies`
          : `No entry — invalidation/stop side reached`;
    return {
      stopDist, tp1, tp2, finalR, rrTarget, tp1Pct, tp2Pct, tp1Book, tp2Book, entryType,
      beRule: `Move SL to break-even ($${fmtPrice(r.entry)}) after TP1 fills or price holds +1R in favor`,
      trailNote: `After TP1, trail the remainder behind structure toward final ${finalR.toFixed(1)}R`,
    };
  }

  // Invalidation checklist — the hard conditions that void the setup.
  function invalidationList(r) {
    const mtfThresh = r.nTf || 0;
    return [
      `Gate score drops below 8/8 on the next scan (now ${r.score8}/8)`,
      `Price closes beyond SL / invalidation at $${fmtPrice(r.stop)} (${(r.slPct||0).toFixed(2)}% away)`,
      `CUSUM regime flips opposite the ${r.dir.toUpperCase()} setup (now ${r.cusumDir})`,
      `MTF agreement drops below ${mtfThresh}/${mtfThresh} (now ${r.mtfAgree}/${r.nTf})`,
      `Funding / market regime turns against the trade (now FR ${(r.fund||0).toFixed(4)}%)`,
    ];
  }

  // Trade-management timeline steps.
  function tradeTimeline(r, plan) {
    return [
      { t: "Pre-entry checks", d: `Confirm still 8/8, CUSUM ${r.cusumDir} aligned, MTF ${r.mtfAgree}/${r.nTf}, funding clean, price in entry zone.` },
      { t: "Entry trigger", d: plan.entryType + "." },
      { t: "TP1 / BE move", d: `Book ${plan.tp1Book}% at TP1 $${fmtPrice(plan.tp1)} (1R), then move SL to break-even $${fmtPrice(r.entry)}.` },
      { t: "Final TP / trailing exit", d: `Book remaining ${plan.tp2Book}% at final $${fmtPrice(plan.tp2)} (${plan.finalR.toFixed(1)}R), or trail behind structure.` },
      { t: "Forced exit conditions", d: `Exit immediately if any invalidation triggers — SL breach, CUSUM flip, MTF break, or funding/regime turn.` },
    ];
  }

  // Assemble a compact exec object for the Telegram payload / copy helpers.
  function execSummary(r) {
    const st = execStatus(r);
    const meta = EXEC_STATUS_META[st.code];
    const plan = execPlan(r);
    const sz = positionSizing(r);
    const cur = (Number.isFinite(r.mark) && r.mark > 0) ? r.mark : r.entry;
    const exec = {
      status: meta.label,
      action: meta.action,
      entryType: plan.entryType,
      curPrice: cur,
      entryDeltaPct: r.entry ? (cur - r.entry) / r.entry * 100 : 0,
      tp1: plan.tp1, tp1Pct: plan.tp1Pct, tp1BookPct: plan.tp1Book,
      tp2: plan.tp2, tp2Pct: plan.tp2Pct, tp2BookPct: plan.tp2Book,
      rrTarget: plan.finalR,
      slPct: r.slPct || 0,
      beRule: "SL to break-even after TP1 (or +1R held)",
      invalidation: invalidationList(r),
    };
    if (sz.valid) {
      exec.sizing = {
        qty: (sz.qty >= 1 ? sz.qty.toFixed(2) : sz.qty.toPrecision(3)) + " units",
        notional: "$" + sz.notional.toFixed(2),
        risk: "$" + sz.riskAmt.toFixed(2) + " (" + sz.riskPct + "%)",
        maxLoss: "$" + sz.maxLoss.toFixed(2),
        lev: sz.levNote,
      };
    }
    return exec;
  }

  /* ====================================================================
   * STRATEGY MATCH LAYER  (rule-based, NOT predictive)
   * --------------------------------------------------------------------
   * Mirrors the assistant's crypto trade-decision discipline. Converts a
   * strict 8/8 setup into an A+ / A / B / NO TRADE grade with an action,
   * a planned-risk size multiplier, and plain reason chips. Everything is
   * a deterministic CHECKLIST over signals the engine already proves —
   * never a confidence %, win-rate, or probability. No order is placed;
   * live execution stays locked.
   *
   * Solid-only signals used (and ONLY these):
   *   - 8/8 strict gate pass            (de-correlated confirmation)
   *   - MTF cascade full agreement       (4h/1h/15m/5m target; current
   *                                       scanner uses configured TFs)
   *   - Judas / Asian-range sweep         (liquidity-grab logic)
   *   - Funding clean & not against       (real crowding signal)
   *   - RSI not exhausted                 (established momentum bound)
   *   - CUSUM regime aligned              (trend not against)
   *   - Structural RR >= target           (reward:risk floor)
   *   - Entry zone (ideal/acceptable/chase/invalidated) — do not chase
   * Family score & Setup Quality are CHECKLIST reads only — never a
   * probability. AI-ensemble / confidence% / win-rate layers are dropped.
   * ================================================================== */

  // Strategy profile gates. Default = Strict Assistant.
  const STRATEGY_PROFILES = {
    balanced: { label: "Balanced", minVisible: "B", minAuto: "A", famUltra: false,
      note: "Shows A+/A/B. Auto-send A and above." },
    strict: { label: "Strict Assistant", minVisible: "B", minAuto: "A", famUltra: false,
      note: "Focus on A+/A; B shown as watch-only. Auto-send A and above." },
    ultra: { label: "Ultra Strict", minVisible: "A", minAuto: "A+", famUltra: true,
      note: "Only A+/A surface; Fam 4/4 preferred. Auto-send A+ only." },
  };
  const GRADE_ORDER = { "A+": 4, "A": 3, "B": 2, "NO TRADE": 0 };
  const GRADE_META = {
    "A+":       { cls: "ok",    tag: "Best trade candidate" },
    "A":        { cls: "ok",    tag: "Tradable with discipline" },
    "B":        { cls: "warn",  tag: "Watch only · reduced confidence" },
    "NO TRADE": { cls: "bad",   tag: "Stand aside" },
  };
  function gradeAtLeast(grade, min) { return (GRADE_ORDER[grade] || 0) >= (GRADE_ORDER[min] || 0); }
  function activeProfile() { return STRATEGY_PROFILES[state.strategyProfile] || STRATEGY_PROFILES.strict; }

  // Core Strategy Match evaluation. Returns a structured decision object.
  function strategyMatch(r) {
    const q = qualityScore(r);                 // checklist score 0-100 (NOT win rate)
    const zone = entryZone(r);                 // ideal | acceptable | chase | invalidated
    const st = execStatus(r);
    const fR = favorR(r);
    const block = Math.max(1e-9, params.funding_block_pct || 0.05);
    const cusumAligned = (r.cusumDir === "UP" && r.dir === "long") || (r.cusumDir === "DOWN" && r.dir === "short");
    const mtfFull = r.nTf ? (r.mtfAgree / r.nTf) >= 1 : false;
    const fam4 = (r.famLong || 0) >= 4;
    const fam3 = (r.famLong || 0) === 3;
    const fundingAgainst = r.fund != null && (
      (r.dir === "long" && r.fund > block) || (r.dir === "short" && r.fund < -block));
    const fundingMixed = !fundingAgainst && r.fund != null && Math.abs(r.fund) > block * 0.6;
    const rsiExhausted = Number.isFinite(r.rsi) && (
      (r.dir === "long" && r.rsi >= (params.rsi_hi || 65)) ||
      (r.dir === "short" && r.rsi <= (params.rsi_lo || 35)));
    const rr = r.rr || 0;
    const slPct = r.slPct || 0;
    const stopWide = slPct > 4.0;              // structural stop unusually wide
    const regimeMixed = r.cusumDir === "FLAT";
    const regimeAgainst = (r.cusumDir === "UP" && r.dir === "short") || (r.cusumDir === "DOWN" && r.dir === "long");

    // ----- reason chips (positive then cautionary) -----
    const chips = [];
    const addPos = (t) => chips.push({ t, k: "pos" });
    const addNeg = (t) => chips.push({ t, k: "neg" });
    if (r.score8 === 8) addPos("8/8 confirmed"); else addNeg(`gate ${r.score8}/8`);
    if (mtfFull) addPos(`MTF ${r.mtfAgree}/${r.nTf}`); else addNeg(`MTF ${r.mtfAgree}/${r.nTf} mismatch`);
    if (cusumAligned) addPos("CUSUM aligned"); else if (regimeAgainst) addNeg("regime against"); else addNeg("regime mixed");
    if (r.judasOk) addPos("Judas yes"); else addNeg("no Judas");
    if (zone === "ideal") addPos("price near entry");
    else if (zone === "acceptable") addNeg("wait for retest");
    else if (zone === "chase") addNeg("chase risk");
    else addNeg("invalidated");
    if (rr >= 2) addPos("RR >= 2"); else if (rr >= 1.8) addPos("RR >= 1.8"); else addNeg(`RR ${rr.toFixed(1)}`);
    if (fam4) addPos("Fam 4/4"); else if (fam3) addNeg("Fam only 3/4"); else addNeg(`Fam ${r.famLong}/4`);
    if (fundingAgainst) addNeg("funding against"); else if (fundingMixed) addNeg("funding mixed");
    if (rsiExhausted) addNeg("RSI exhausted");
    if (stopWide) addNeg("stop wide");

    // ----- grade decision (strict precedence) -----
    let grade, why;
    const hardNo = r.score8 < 8 || zone === "invalidated" || q < 45 ||
      !cusumAligned || !mtfFull || regimeAgainst || rsiExhausted;
    if (hardNo) {
      grade = "NO TRADE";
      why = r.score8 < 8 ? "gate score below 8"
        : zone === "invalidated" ? "setup invalidated / beyond stop"
        : q < 45 ? "setup quality below 45"
        : !mtfFull ? "MTF cascade not full"
        : !cusumAligned ? "CUSUM/regime not aligned"
        : rsiExhausted ? "RSI exhausted"
        : "regime against";
    } else {
      // A+ : everything aligned, ideal/acceptable zone, RR>=2, stop sane, fam 4/4
      //      (allow fam 3/4 only if quality high AND zone ideal).
      const aPlusFam = fam4 || (fam3 && q >= 75 && zone === "ideal");
      const aPlus = q >= 75 && (zone === "ideal" || zone === "acceptable") &&
        rr >= 2 && !stopWide && !fundingAgainst && aPlusFam && !regimeMixed;
      const aGrade = q >= 60 && zone !== "chase" && rr >= 1.8;
      if (aPlus) { grade = "A+"; why = "all gates aligned, ideal entry, RR>=2"; }
      else if (aGrade) { grade = "A"; why = "8/8 aligned, tradable with discipline"; }
      else { grade = "B"; why = "8/8 but reduced — wait for retest/pullback"; }
      // B downgrade conditions also catch fam 3/4 + mid quality + non-ideal zone
      if (grade === "A" && (fam3 && (q < 60 || zone === "chase") )) grade = "B";
      if (grade !== "B" && (q >= 45 && q < 60) && zone !== "ideal") grade = "B";
    }

    // ----- action wording (assistant-style) -----
    let action;
    if (grade === "NO TRADE") {
      action = (zone === "invalidated") ? "Avoid / setup invalidated"
        : (zone === "chase") ? "Do not chase"
        : "Avoid / setup invalidated";
    } else if (zone === "chase") {
      action = "Do not chase";
    } else if ((grade === "A+" || grade === "A") && zone === "ideal") {
      action = "Enter now with partial size";
    } else {
      action = "Wait for pullback/retest";
    }

    // ----- size multiplier (× planned risk) -----
    let sizeMult;
    if (grade === "NO TRADE") sizeMult = 0;
    else if (grade === "A+" && zone === "ideal") sizeMult = 1.00;
    else if (grade === "A") sizeMult = (zone === "ideal") ? 0.75 : 0.50;
    else if (grade === "A+") sizeMult = 0.75; // A+ but acceptable zone
    else sizeMult = 0.25;                      // B / watch
    // Reduce on cautionary context.
    if (sizeMult > 0) {
      if (fam3) sizeMult = Math.min(sizeMult, grade === "A+" ? 0.75 : 0.50);
      if (fundingMixed) sizeMult *= 0.75;
      if (stopWide) sizeMult *= 0.75;
      if (zone === "chase") sizeMult = Math.min(sizeMult, 0.25);
      if (regimeMixed) sizeMult *= 0.75;
      sizeMult = Math.max(0, Math.round(sizeMult * 100) / 100);
      if (grade === "B") sizeMult = Math.min(sizeMult, 0.25); // B cap: 0.25x / paper
    }
    const sizeNote = grade === "NO TRADE" ? "0× — stand aside"
      : grade === "B" ? `${sizeMult.toFixed(2)}× planned risk (max — paper preferred)`
      : `${sizeMult.toFixed(2)}× planned risk`;

    return {
      grade, action, why, zone, q, sizeMult, sizeNote,
      meta: GRADE_META[grade],
      chips,
      // top reasons for Telegram / copy (max 6, positives first)
      topReasons: chips.slice().sort((a, b) => (a.k === b.k ? 0 : a.k === "pos" ? -1 : 1))
        .slice(0, 6).map(c => c.t),
      fam4, fam3, fundingMixed, fundingAgainst, rsiExhausted, stopWide, regimeMixed,
      cusumAligned, mtfFull,
    };
  }

  // Sort comparator: by strategy grade (A+>A>B>No Trade), then setup quality.
  function strategyCompare(a, b) {
    const ga = strategyMatch(a), gb = strategyMatch(b);
    const d = (GRADE_ORDER[gb.grade] || 0) - (GRADE_ORDER[ga.grade] || 0);
    if (d !== 0) return d;
    return gb.q - ga.q;
  }

  /* ====================================================================
   * CONFIRMATORY SIGNAL LAYER  (rule-based, deterministic — NOT predictive)
   * --------------------------------------------------------------------
   * Runs AFTER the strict 8-gate scan and the Strategy Match grade. It only
   * CONFIRMS, reduces, or blocks a trade by combining crypto-native context:
   *   - BTC / ETH market regime (with / against / mixed / unavailable)
   *   - Funding pressure (supports / clean / crowded / against)
   *   - Open interest (rising/falling confirmation — or unavailable)
   *   - Volume confirmation (expansion / weak / neutral / unavailable)
   *   - VWAP / EMA price location (aligned / against)
   *   - Judas / retest entry zone (entry/retest ok vs chase)
   *   - Liquidity quality (ok / moderate / thin)
   *   - Event/news risk (manual check required — never auto-scraped)
   * Output is one of GREEN / YELLOW / ORANGE / RED plus a size multiplier and
   * reason chips. It is NEVER a probability, win-rate, or forecast and it NEVER
   * edits the raw scanner report or the 8-gate verdict.
   * ================================================================== */
  const CONFIRM_META = {
    GREEN:  { cls: "ok",    label: "Entry allowed",   action: "Entry eligible — partial size", mult: 1.00 },
    YELLOW: { cls: "warn",  label: "Wait for retest", action: "Wait for retest / confirmation", mult: 0.50 },
    ORANGE: { cls: "warn2", label: "Reduce size",     action: "Reduce size — mixed context",    mult: 0.50 },
    RED:    { cls: "bad",   label: "No trade",        action: "No trade — stand aside",         mult: 0.00 },
  };
  const CONFIRM_ORDER = { GREEN: 3, YELLOW: 2, ORANGE: 1, RED: 0 };

  // Per-component reads. Each returns { state, chip, k } where k = pos|neg|warn|na.
  function regimeComponent(r) {
    const reg = state.marketRegime;
    if (!reg || !reg.available) return { state: "unavailable", chip: "BTC regime n/a", k: "na" };
    const bias = reg.bias;                       // UP | DOWN | FLAT
    if (bias === "FLAT") return { state: "mixed", chip: "BTC mixed", k: "warn" };
    const aligned = (bias === "UP" && r.dir === "long") || (bias === "DOWN" && r.dir === "short");
    const strong = (reg.strength || 0) >= 1.6;   // CUSUM std units (not a probability)
    if (aligned) return { state: "aligned", chip: "BTC aligned", k: "pos" };
    return { state: strong ? "against-strong" : "against", chip: strong ? "BTC strongly against" : "BTC against", k: "neg" };
  }
  function fundingComponent(r) {
    if (r.fund == null) return { state: "unavailable", chip: "funding n/a", k: "na" };
    const block = Math.max(1e-9, params.funding_block_pct || 0.05);
    const crowdedAbs = 0.3;                       // >0.3% = crowded/block per strategy rules
    const against = (r.dir === "long" && r.fund > block) || (r.dir === "short" && r.fund < -block);
    const crowded = Math.abs(r.fund) > crowdedAbs;
    // "supports": funding tilts in favor of the trade (shorts paid on a short, longs paid on a long)
    const supports = (r.dir === "long" && r.fund < -block * 0.5) || (r.dir === "short" && r.fund > block * 0.5);
    if (crowded) return { state: "crowded", chip: "funding crowded", k: "neg" };
    if (against) return { state: "against", chip: "funding against", k: "neg" };
    if (supports) return { state: "supports", chip: "funding supports", k: "pos" };
    return { state: "clean", chip: "funding clean", k: "pos" };
  }
  function oiComponent(r) {
    if (r.oi == null) return { state: "unavailable", chip: "OI n/a", k: "na" };
    // Without a historical OI series we cannot prove rising/falling; we report
    // OI presence as neutral context rather than fabricating a delta direction.
    return { state: "present", chip: "OI present", k: "warn" };
  }
  function volumeComponent(r) {
    if (r.volRatio == null) return { state: "unavailable", chip: "volume n/a", k: "na" };
    if (r.volRatio >= 1.5) return { state: "spike", chip: "volume spike", k: "pos" };
    if (r.volRatio >= 1.1) return { state: "expansion", chip: "volume confirms", k: "pos" };
    if (r.volRatio >= 0.8) return { state: "neutral", chip: "volume neutral", k: "warn" };
    return { state: "weak", chip: "volume weak", k: "neg" };
  }
  function vwapComponent(r) {
    const loc = r.vwapLoc || r.emaLoc;
    if (!loc) return { state: "unavailable", chip: "VWAP n/a", k: "na" };
    // shorts cleaner below VWAP/EMA; longs cleaner above.
    const aligned = (r.dir === "long" && loc === "above") || (r.dir === "short" && loc === "below");
    return aligned
      ? { state: "aligned", chip: "VWAP aligned", k: "pos" }
      : { state: "against", chip: "VWAP against", k: "neg" };
  }
  function retestComponent(r) {
    const zone = entryZone(r);                    // ideal | acceptable | chase | invalidated
    if (zone === "ideal") return { state: "entry", chip: "retest ok", k: "pos" };
    if (zone === "acceptable") return { state: "retest", chip: "wait for retest", k: "warn" };
    if (zone === "chase") return { state: "chase", chip: "chase risk", k: "neg" };
    return { state: "invalidated", chip: "invalidated", k: "neg" };
  }
  function liquidityComponent(r) {
    const lq = r.liqQuality;
    if (!lq) return { state: "unavailable", chip: "liquidity n/a", k: "na" };
    if (lq === "ok") return { state: "ok", chip: "liquidity ok", k: "pos" };
    if (lq === "moderate") return { state: "moderate", chip: "liquidity moderate", k: "warn" };
    return { state: "thin", chip: "liquidity thin", k: "neg" };
  }
  function eventComponent() {
    // No news scraping in this upgrade — always a manual-check placeholder.
    return { state: "manual", chip: "event risk: manual check", k: "warn" };
  }

  // Core confirmatory evaluation. Deterministic precedence: RED > ORANGE >
  // YELLOW > GREEN. Mirrors the approved final-action rule.
  function confirmatory(r) {
    const sm = strategyMatch(r);
    const regime = regimeComponent(r);
    const funding = fundingComponent(r);
    const oi = oiComponent(r);
    const volume = volumeComponent(r);
    const vwap = vwapComponent(r);
    const retest = retestComponent(r);
    const liq = liquidityComponent(r);
    const event = eventComponent();
    const comps = { regime, funding, oi, volume, vwap, retest, liq, event };

    const cusumAligned = (r.cusumDir === "UP" && r.dir === "long") || (r.cusumDir === "DOWN" && r.dir === "short");
    const mtfFull = r.nTf ? (r.mtfAgree / r.nTf) >= 1 : false;
    const eightEight = r.score8 === 8;
    const stratOk = sm.grade === "A+" || sm.grade === "A";

    // ----- RED conditions (hard blocks) -----
    const redReasons = [];
    if (sm.grade === "NO TRADE") redReasons.push("Strategy Match No Trade");
    if (retest.state === "invalidated") redReasons.push("setup invalidated");
    if (!eightEight) redReasons.push(`gate ${r.score8}/8`);
    if (!cusumAligned || !mtfFull) redReasons.push("CUSUM/MTF mismatch");
    if (regime.state === "against-strong") redReasons.push("BTC strongly against");
    if (funding.state === "against" || funding.state === "crowded") redReasons.push("funding against/crowded");
    if (retest.state === "chase") redReasons.push("chase risk severe");

    // ----- ORANGE conditions (valid but mixed) -----
    const orangeReasons = [];
    if (regime.state === "against") orangeReasons.push("BTC against");
    if (regime.state === "mixed") orangeReasons.push("BTC mixed");
    if (liq.state === "thin") orangeReasons.push("liquidity thin");
    if (vwap.state === "against") orangeReasons.push("VWAP against");
    if (volume.state === "weak") orangeReasons.push("volume weak");
    if (sm.stopWide) orangeReasons.push("stop distance wide");
    if (sm.fundingMixed) orangeReasons.push("funding mixed");

    // ----- YELLOW conditions (good but needs retest / a neutral-or-missing piece) -----
    const yellowReasons = [];
    if (retest.state === "retest") yellowReasons.push("price needs retest");
    if (volume.state === "neutral") yellowReasons.push("volume neutral");
    if (regime.state === "unavailable") yellowReasons.push("BTC regime n/a");
    if (oi.state === "unavailable") yellowReasons.push("OI n/a");
    if (volume.state === "unavailable") yellowReasons.push("volume n/a");
    if (liq.state === "moderate") yellowReasons.push("liquidity moderate");

    let status, why;
    if (redReasons.length) { status = "RED"; why = redReasons[0]; }
    else if (orangeReasons.length) { status = "ORANGE"; why = orangeReasons[0]; }
    else if (!stratOk) { status = "YELLOW"; why = "Strategy Match below A"; }
    else if (yellowReasons.length) { status = "YELLOW"; why = yellowReasons[0]; }
    else {
      // GREEN requires 8/8, Strategy A/A+, regime not against, funding not
      // against/crowded, volume confirms-or-neutral, price near entry/retest,
      // liquidity acceptable.
      const regimeOk = regime.state === "aligned" || regime.state === "unavailable";
      const volOk = volume.state === "spike" || volume.state === "expansion" || volume.state === "neutral" || volume.state === "unavailable";
      const priceOk = retest.state === "entry";
      const liqOk = liq.state === "ok" || liq.state === "moderate" || liq.state === "unavailable";
      if (eightEight && stratOk && regimeOk && volOk && priceOk && liqOk) { status = "GREEN"; why = "all confirmatory checks pass"; }
      else { status = "YELLOW"; why = "awaiting cleaner confirmation"; }
    }

    const meta = CONFIRM_META[status];
    // Size multiplier from this layer (applied AFTER Strategy Match conceptually).
    let mult = meta.mult;
    if (status === "ORANGE") {
      // graded reduction: more mixed flags => smaller size, floor 0.25
      mult = orangeReasons.length >= 2 ? 0.25 : 0.50;
    }
    if (status === "YELLOW") mult = 0.50;
    mult = Math.max(0, Math.round(mult * 100) / 100);
    const sizeNote = status === "RED" ? "0× — stand aside"
      : `${mult.toFixed(2)}× (after Strategy Match ${sm.sizeMult.toFixed(2)}×)`;
    const combinedMult = Math.max(0, Math.round(sm.sizeMult * mult * 100) / 100);

    // Reason chips: positives first, then warnings, then n/a; cautionary chips
    // (neg) are surfaced prominently before warnings.
    const order = { pos: 0, neg: 1, warn: 2, na: 3 };
    const chips = Object.values(comps).slice().sort((a, b) => order[a.k] - order[b.k]);
    const topReasons = chips.filter(c => c.k !== "na").slice(0, 7).map(c => c.chip);

    return {
      status, why, meta, mult, combinedMult, sizeNote,
      comps, chips, topReasons,
      strategyGrade: sm.grade,
    };
  }
  function confirmAtLeast(status, min) { return (CONFIRM_ORDER[status] || 0) >= (CONFIRM_ORDER[min] || 0); }

  /* ---------- Formation Radar (about-to-form layer) ----------
   * Combines the strict 8-gate score into a readiness label and surfaces the
   * gates still missing. Context/overlay only — it NEVER changes the raw 8/8
   * verdict, never executes, and is not a probability or win rate.
   */
  const FORMATION_META = {
    FORMED:  { label: "FORMED 8/8",  cls: "ok",    hint: "All eight gates cleared" },
    NEAR:    { label: "NEAR 7/8",    cls: "warn",  hint: "One gate away from strict 8/8" },
    FORMING: { label: "FORMING 6/8", cls: "warn2", hint: "Two gates away — building" },
    EARLY:   { label: "EARLY 5/8",   cls: "warn2", hint: "Three gates away — early watch" },
    IGNORE:  { label: "IGNORE",      cls: "bad",   hint: "Below watch threshold" },
  };
  function formation(r) {
    const score = r.score8 || 0;
    const label = score >= 8 ? "FORMED"
      : score === 7 ? "NEAR"
      : score === 6 ? "FORMING"
      : score === 5 ? "EARLY" : "IGNORE";
    const missing = GATES.filter(g => !r.gateMap[g.key]);
    const present = GATES.filter(g => r.gateMap[g.key]);
    const gatesAway = missing.length;
    const readiness = score >= 8 ? "Formed — all 8 gates aligned"
      : gatesAway === 1 ? "1 gate away from strict 8/8"
      : `${gatesAway} gates away from strict 8/8`;
    const whyWatch = present.slice(0, 5).map(g => g.label);
    // ---- Email-alert readiness (criteria mirror; the app never sends email) ----
    // Eligible only for a not-yet-sent 7/8 or 8/8 whose Strategy Match is A/A+
    // (or a strong B) AND confirmatory is GREEN/YELLOW (never RED / no-trade).
    const sm = strategyMatch(r);
    const cf = confirmatory(r);
    const notSent = setupState(r) !== "sent";
    const gradeOk = sm.grade === "A+" || sm.grade === "A" || (sm.grade === "B" && (sm.q || 0) >= 55);
    const confOk = cf.status === "GREEN" || cf.status === "YELLOW";
    const emailEligible = score >= 7 && notSent && gradeOk && confOk &&
      sm.grade !== "NO TRADE" && cf.status !== "RED";
    return {
      label, meta: FORMATION_META[label], missing, present, gatesAway,
      readiness, whyWatch, emailEligible, grade: sm.grade, confStatus: cf.status,
    };
  }

  /* ---------- Directional bias / edge score ----------
   * DETERMINISTIC rule-based lean toward LONG vs SHORT from live technical
   * evidence + the current BTC/ETH market regime + a lightweight session
   * scanner-memory proxy (NOT exchange PnL / win rate). Chances sum to 100 and
   * are clamped to [5,95] so the score is never presented as a certainty.
   */
  const BIAS_DESC = (gap) => gap < 10 ? "Neutral" : gap < 25 ? "Mild" : gap < 45 ? "Moderate" : "Strong";
  function directionalBias(r) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const sgn = r.dir === "long" ? 1 : r.dir === "short" ? -1 : 0;
    const reasons = []; // { t, w(signed) } — sign shows long(+)/short(-) lean
    let score = 0;
    const add = (w, t) => { score += w; if (t) reasons.push({ t, w }); };

    if (sgn) add(sgn * (5 + 5 * clamp((r.famLong || 0) / 4, 0, 1)),
      `Cascade ${sgn > 0 ? "UP" : "DOWN"} Fam ${r.famLong || 0}/4`);
    if (sgn && r.nTf) {
      const frac = clamp((r.mtfAgree || 0) / r.nTf, 0, 1);
      add(sgn * 10 * frac, `MTF ${r.mtfAgree || 0}/${r.nTf} ${sgn > 0 ? "UP" : "DOWN"}`);
    }
    if (r.cusumDir === "UP" || r.cusumDir === "DOWN") {
      const cs = clamp((r.cusumScore || 1) / 2, 0.3, 1);
      add((r.cusumDir === "UP" ? 1 : -1) * 12 * cs, `CUSUM ${r.cusumDir}`);
    }
    if (Number.isFinite(r.rsi)) add(clamp((r.rsi - 50) / 15, -1, 1) * 7, `RSI ${r.rsi.toFixed(0)}`);
    if (Number.isFinite(r.fund) && r.fund !== 0) {
      add(clamp(-r.fund / 0.05, -1, 1) * 6, `Funding ${r.fund > 0 ? "+" : ""}${r.fund.toFixed(3)}%`);
    }
    if (sgn && r.judasOk) add(sgn * 6, `Judas ${sgn > 0 ? "UP" : "DOWN"}`);
    if (r.vwapLoc === "above" || r.emaLoc === "above") add(5, "Price above VWAP/EMA");
    else if (r.vwapLoc === "below" || r.emaLoc === "below") add(-5, "Price below VWAP/EMA");

    // BTC/ETH market regime (when available this scan).
    const reg = state.marketRegime;
    if (reg && reg.available && (reg.bias === "UP" || reg.bias === "DOWN")) {
      const rs = clamp((reg.strength || 1) / 2, 0.3, 1);
      add((reg.bias === "UP" ? 1 : -1) * 8 * rs, `BTC regime ${reg.bias}`);
    }

    // Session scanner-memory proxy: repeated same-direction signals this session
    // nudge the lean slightly. Clearly NOT exchange PnL history.
    const h = state.biasHistory.get(r.sym);
    if (h && h.scans >= 2) {
      const net = (h.longSignals - h.shortSignals) / h.scans; // -1..1
      if (Math.abs(net) > 0.15) add(clamp(net, -1, 1) * 6, `Repeat ${net > 0 ? "long" : "short"} signal ×${h.scans}`);
    }

    const longChance = clamp(Math.round(50 + clamp(score, -45, 45)), 5, 95);
    const shortChance = 100 - longChance;
    const gap = Math.abs(longChance - shortChance);
    const biasSide = gap < 10 ? "NEUTRAL" : (longChance > shortChance ? "LONG" : "SHORT");
    const strength = BIAS_DESC(gap);
    const biasLabel = biasSide === "NEUTRAL" ? "Neutral"
      : `${strength} ${biasSide === "LONG" ? "Long" : "Short"} Bias`;
    const sideSign = biasSide === "LONG" ? 1 : biasSide === "SHORT" ? -1 : 0;
    const biasReasons = reasons
      .sort((a, b) => {
        const aa = sideSign && a.w * sideSign > 0, ba = sideSign && b.w * sideSign > 0;
        if (aa !== ba) return aa ? -1 : 1;
        return Math.abs(b.w) - Math.abs(a.w);
      })
      .slice(0, 4).map(x => x.t);
    return { longChance, shortChance, biasSide, biasConfidence: gap, biasLabel, biasReasons };
  }

  // Update the session bias proxy once per scan (called from runScan).
  function updateBiasHistory(results) {
    results.forEach(r => {
      if (!r.dir) return;
      const h = state.biasHistory.get(r.sym) || { scans: 0, longSignals: 0, shortSignals: 0 };
      h.scans += 1;
      if (r.dir === "long") h.longSignals += 1; else if (r.dir === "short") h.shortSignals += 1;
      state.biasHistory.set(r.sym, h);
    });
  }

  // Compact bias bar + label HTML (mobile-first). Used on cards + radar rows.
  function biasBarHTML(r, opts) {
    const b = directionalBias(r);
    const lc = b.longChance, sc = b.shortChance;
    const lead = b.biasSide === "LONG" ? "long" : b.biasSide === "SHORT" ? "short" : "neu";
    const chips = (opts && opts.chips) ? b.biasReasons.slice(0, 4).map(t =>
      `<span class="bchip">${esc(t)}</span>`).join("") : "";
    const chipWrap = chips ? `<div class="bchips">${chips}</div>` : "";
    return `<div class="biaswrap ${lead}" data-testid="bias-${esc(r.sym)}">
      <div class="biasbar" title="Rule-based directional lean (edge score) — NOT a probability or win rate">
        <span class="bseg long" style="width:${lc}%"><b>LONG ${lc}</b></span>
        <span class="bseg short" style="width:${sc}%"><b>SHORT ${sc}</b></span>
      </div>
      <div class="biaslabelrow"><span class="biaslabel ${lead}">${esc(b.biasLabel)}</span> <small style="color:var(--dim2)">lean score · not a probability</small></div>
      ${chipWrap}
    </div>`;
  }

  // Setup validity / freshness — DETERMINISTIC, rule-based read of whether a
  // setup is still actionable right now (gate strength, price-vs-entry distance,
  // chase/stretch, bias agreement, formation, optional scan age). Scanner
  // freshness only — NOT a guarantee, fill probability, or win rate. Mirrors
  // scanner.js validityFreshness so the report and UI stay consistent.
  function validityFreshness(r) {
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const dir = r.dir;
    const s8 = r.score8 || 0;
    const formation = s8 >= 8 ? "FORMED" : s8 === 7 ? "NEAR" : s8 === 6 ? "FORMING"
      : s8 === 5 ? "EARLY" : "IGNORE";
    if (!dir || formation === "IGNORE" || s8 < 5) {
      const why = !dir ? "no direction" : formation === "IGNORE" ? "no-trade" : "too few gates";
      return { validityStatus: "INVALID", validityPct: 0, validityLabel: "Invalid — no clear setup",
        validityReasons: [why, "rule-based freshness"] };
    }
    const reasons = [];
    let pct = 50;
    const add = (w, t) => { pct += w; if (t) reasons.push({ t, w }); };

    if (r.passed || s8 >= 8) add(28, "8/8 gates");
    else if (s8 === 7) add(18, "7/8 gates");
    else if (s8 === 6) add(6, "6/8 forming");
    else add(-6, `${s8}/8 early`);

    const dpct = Math.abs(r.entryDeltaPct || 0);
    const fav = dir === "long" ? (r.entryDeltaPct || 0) : -(r.entryDeltaPct || 0);
    if (dpct <= 0.4) add(20, "near entry");
    else if (dpct <= 1.0) add(10, "near entry");
    else if (dpct <= 2.0) add(0, null);
    else if (dpct <= 4.0) add(-14, "price drifting");
    else add(-26, "price far from entry");
    if (fav > 2) add(-10, "entry chased");
    else if (fav < -3) add(-8, "structure weakening");
    else if (dpct <= 1.0) add(8, "not chased");

    if (r.stretched) add(-15, "too stretched");
    if (r.priceDiv) add(-8, "price divergence");

    const b = directionalBias(r);
    const bSide = b.biasSide === "LONG" ? "long" : b.biasSide === "SHORT" ? "short" : "neu";
    const biasConflict = bSide !== "neu" && bSide !== dir;
    if (bSide === dir) add(8, "bias aligned");
    else if (biasConflict) add(-12, "bias conflict");

    if (formation === "FORMED") add(6, null);
    else if (formation === "NEAR") add(2, null);
    else if (formation === "FORMING") add(-4, "forming");
    else if (formation === "EARLY") add(-10, "early");

    if ((r.rr || 0) >= 2) add(5, "RR ok");
    else if (r.rr && r.rr < 1) add(-8, "thin RR");

    // Real scan age from this session's last scan timestamp (honest, not faked).
    if (state.lastScanAt) {
      const ageMin = (Date.now() - state.lastScanAt) / 60000;
      if (ageMin <= 3) add(6, "scan fresh");
      else if (ageMin <= 10) add(0, null);
      else if (ageMin <= 30) add(-8, "scan aging");
      else add(-18, "scan stale");
    }

    pct = Math.round(clamp(pct, 0, 100));
    const nearEntry = dpct <= 0.6 && fav <= 2;
    let validityStatus;
    if (biasConflict) validityStatus = pct < 35 ? "INVALID" : "STALE";
    else if (pct >= 72 && s8 >= 7 && nearEntry && !r.stretched) validityStatus = "FRESH";
    else if (pct >= 58) validityStatus = "VALID";
    else if (pct >= 40) validityStatus = "WATCH";
    else validityStatus = (s8 >= 6 && !r.stretched && fav < 2) ? "WATCH" : "STALE";

    const validityLabel = {
      FRESH: "Fresh — near plan", VALID: "Valid — actionable", WATCH: "Watch — wait for entry",
      STALE: "Stale — moved away", INVALID: "Invalid",
    }[validityStatus];

    const wantPos = validityStatus === "FRESH" || validityStatus === "VALID";
    const validityReasons = reasons
      .sort((a, c) => {
        const aa = wantPos ? a.w > 0 : a.w < 0, ca = wantPos ? c.w > 0 : c.w < 0;
        if (aa !== ca) return aa ? -1 : 1;
        return Math.abs(c.w) - Math.abs(a.w);
      })
      .slice(0, 3).map(x => x.t);
    validityReasons.push("rule-based freshness");
    return { validityStatus, validityPct: pct, validityLabel, validityReasons };
  }

  // Compact validity bar + chips HTML (mobile-first). Used on cards + radar rows.
  function validityBarHTML(r, opts) {
    const v = validityFreshness(r);
    const cls = v.validityStatus.toLowerCase();
    const showChips = opts && opts.chips;
    const chips = showChips ? v.validityReasons.slice(0, 3).map(t =>
      `<span class="vchip">${esc(t)}</span>`).join("") : "";
    const chipWrap = chips ? `<div class="vchips">${chips}</div>` : "";
    return `<div class="valwrap ${cls}" data-testid="validity-${esc(r.sym)}">
      <div class="valbar" title="Rule-based scanner freshness — not a guarantee or win rate">
        <span class="vseg ${cls}" style="width:${v.validityPct}%"></span>
        <span class="vtext"><b>${esc(v.validityStatus)} ${v.validityPct}%</b> <span class="vlbl">${esc(v.validityLabel)}</span></span>
      </div>
      ${chipWrap}
    </div>`;
  }

  /* ====================================================================
   * COIN SEARCH ANALYZER — filter the latest scan rows and show one coin.
   * Rule-based, reuses the existing bias/validity/formation overlays. No
   * network call: analyzes whatever the last scan already returned.
   * ================================================================== */
  function findCoin(q) {
    q = (q || "").trim().toUpperCase();
    if (!q) return null;
    const rows = state.results || [];
    return rows.find(r => r.sym.toUpperCase() === q)
      || rows.find(r => r.sym.toUpperCase().startsWith(q))
      || rows.find(r => r.sym.toUpperCase().includes(q))
      || null;
  }
  function renderCoinPanel() {
    const el = $("#coinPanel"); if (!el) return;
    const input = $("#coinSearch");
    const q = (input && input.value) || "";
    if (!q.trim()) { el.innerHTML = ""; return; }
    if (!(state.results && state.results.length)) {
      el.innerHTML = `<div class="coinmiss">No scan loaded yet. <b>Run a scan first</b>, then search a symbol.</div>`;
      return;
    }
    const r = findCoin(q);
    if (!r) {
      el.innerHTML = `<div class="coinmiss">No match for <b>${esc(q.toUpperCase())}</b> in the latest scan. Check the spelling (e.g. <b>BTCUSD</b>) or run a fresh scan — only scanned symbols can be analyzed.</div>`;
      return;
    }
    const fm = formation(r);
    const sm = strategyMatch(r);
    const d = r.dir;
    const sideCls = d === "long" ? "long" : d === "short" ? "short" : "neu";
    const sideTxt = d ? d.toUpperCase() : "NEUTRAL";
    const reasons = sm.topReasons.slice(0, 3);
    el.innerHTML = `<div class="coinpanel ${sideCls}" data-testid="coin-panel-${esc(r.sym)}">
      <div class="cphead">
        <span class="cpsym">${esc(r.sym)}</span>
        <span class="cpside ${sideCls}">${esc(sideTxt)}</span>
        <span class="cpscore">${r.score8}/8 · ${esc(fm.meta.label)}</span>
      </div>
      ${biasBarHTML(r, { chips: false })}
      ${validityBarHTML(r, { chips: false })}
      <div class="brlevels">Entry <b>$${fmtPrice(r.entry)}</b> · SL <b>$${fmtPrice(r.stop)}</b> (${(r.slPct || 0).toFixed(2)}%) · TP <b>$${fmtPrice(r.target)}</b> (${(r.tpPct || 0).toFixed(2)}%) · RR <b>${(r.rr || 0).toFixed(1)}</b></div>
      <ul class="cpreasons">${reasons.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`;
  }

  /* ====================================================================
   * BEST 8/8 RANKING — deterministic composite score over strict survivors.
   * Combines validity, formation, bias alignment, RR, family quality, MTF,
   * funding cleanliness, stretch, and market regime. NOT a win-rate.
   * ================================================================== */
  function rankScore(r) {
    const v = validityFreshness(r);
    const b = directionalBias(r);
    const aligned = (b.biasSide === "LONG" && r.dir === "long") || (b.biasSide === "SHORT" && r.dir === "short");
    let s = (v.validityPct || 0);            // 0-100, freshness/validity weight
    if (r.score8 === 8) s += 40;
    if (r.formation === "FORMED" || r.score8 >= 8) s += 15;
    if (aligned) s += (b.biasConfidence || 0); // 0-90, bias agrees with side
    s += Math.min(20, (r.rr || 0) * 7);        // RR
    s += (r.score4 || 0) * 0.25;               // family quality /100
    if (r.nTf) s += (r.mtfAgree / r.nTf) * 10; // MTF agreement
    const block = params.funding_block_pct || 0.05;
    if (r.fund != null && Math.abs(r.fund) <= block) s += 8; // funding clean
    if (!r.stretched) s += 6;
    const reg = state.marketRegime;
    if (reg && reg.available) {
      if ((reg.bias === "UP" && r.dir === "long") || (reg.bias === "DOWN" && r.dir === "short")) s += 6;
      else if ((reg.bias === "UP" && r.dir === "short") || (reg.bias === "DOWN" && r.dir === "long")) s -= 6;
    }
    return s;
  }
  function bestSetups(results, n) {
    return (results || []).filter(r => r.passed && r.score8 === 8)
      .map(r => ({ r, s: rankScore(r) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, n || 3);
  }
  function bestWhy(r) {
    const v = validityFreshness(r);
    const b = directionalBias(r);
    const aligned = (b.biasSide === "LONG" && r.dir === "long") || (b.biasSide === "SHORT" && r.dir === "short");
    const bits = [`validity ${v.validityStatus} ${v.validityPct}`];
    if (aligned) bits.push(`bias aligned ${b.longChance}/${b.shortChance}`);
    bits.push(`RR ${(r.rr || 0).toFixed(1)}`, `Fam ${r.famLong}/4`);
    if (r.nTf) bits.push(`MTF ${r.mtfAgree}/${r.nTf}`);
    if (!r.stretched) bits.push("not stretched");
    return bits;
  }
  function renderBestRank(results) {
    const el = $("#bestRank"); if (!el) return;
    if (!results || !results.length) {
      el.innerHTML = `<div class="empty"><span class="big">No ranking yet</span>Run a scan — the top three 8/8 setups appear here.</div>`;
      return;
    }
    const top = bestSetups(results, 3);
    if (!top.length) {
      el.innerHTML = `<div class="empty"><span class="big">No 8/8 setups</span>Nothing cleared all eight gates this scan — nothing to rank.</div>`;
      return;
    }
    el.innerHTML = `<div class="bestrank">` + top.map(({ r }, i) => {
      const b = directionalBias(r);
      const v = validityFreshness(r);
      const d = r.dir;
      return `<div class="brcard ${d}" data-testid="best-rank-${i + 1}">
        <div class="brtop">
          <span class="brrank">#${i + 1}</span>
          <span class="brsym">${esc(r.sym)}</span>
          <span class="brside ${d}">${d.toUpperCase()}</span>
          <span class="brmetrics">${v.validityStatus} ${v.validityPct} · bias ${b.biasSide[0]} ${b.longChance}/${b.shortChance}</span>
        </div>
        <div class="brlevels">Entry <b>$${fmtPrice(r.entry)}</b> · SL <b>$${fmtPrice(r.stop)}</b> (${(r.slPct || 0).toFixed(2)}%) · TP <b>$${fmtPrice(r.target)}</b> (${(r.tpPct || 0).toFixed(2)}%) · RR <b>${(r.rr || 0).toFixed(1)}</b></div>
        <div class="brwhy">Why: ${esc(bestWhy(r).join(" · "))}</div>
      </div>`;
    }).join("") + `</div>`;
  }
  // One-line "Best 8/8" summary for the scanner report (empty when none).
  function bestReportLine(results) {
    const top = bestSetups(results, 1)[0];
    if (!top) return "";
    const r = top.r;
    return `Best clean: ${r.sym} ${r.dir.toUpperCase()} — ${bestWhy(r).slice(0, 3).join(" · ")}`;
  }

  /* ====================================================================
   * TRADE CALCULATOR — risk, size, PnL, conservative leverage. Approximate;
   * liquidation is exchange-specific. Rule-based, no orders.
   * ================================================================== */
  function fnum(sel) { const el = $(sel); const v = parseFloat(el && el.value); return Number.isFinite(v) ? v : NaN; }
  function calcCompute() {
    const out = $("#calcOut"); if (!out) return;
    const acct = fnum("#calcAcct"), riskPct = fnum("#calcRisk");
    const side = ($("#calcSide") || {}).value || "long";
    const entry = fnum("#calcEntry"), sl = fnum("#calcSL"), tp = fnum("#calcTP"), levIn = fnum("#calcLev");
    if (!(entry > 0) || !(sl > 0) || entry === sl) {
      out.innerHTML = `<div class="tout"><span class="tl">Status</span><span class="tv warn">Enter entry & stop loss</span></div>`;
      return;
    }
    const dirSign = side === "long" ? 1 : -1;
    const stopDist = Math.abs(entry - sl);
    const stopPct = stopDist / entry * 100;
    const riskAmt = (acct > 0 && riskPct > 0) ? acct * riskPct / 100 : NaN;
    const notional = (Number.isFinite(riskAmt) && stopPct > 0) ? riskAmt / (stopPct / 100) : NaN;
    const qty = (Number.isFinite(notional) && entry > 0) ? notional / entry : NaN;
    const tpValid = tp > 0;
    const tpPct = tpValid ? Math.abs(tp - entry) / entry * 100 : NaN;
    const rr = (tpValid && stopDist > 0) ? Math.abs(tp - entry) / stopDist : NaN;
    const pnlAtTp = (tpValid && Number.isFinite(qty)) ? (tp - entry) * dirSign * qty : NaN;
    const lossAtSl = Number.isFinite(qty) ? (sl - entry) * dirSign * qty : NaN; // negative
    // Conservative leverage so a full stop-out stays well under the margin.
    const suggLev = stopPct > 0 ? Math.max(1, Math.min(20, Math.floor(50 / stopPct))) : NaN;
    const lev = (Number.isFinite(levIn) && levIn > 0) ? levIn : suggLev;
    const margin = (Number.isFinite(notional) && lev > 0) ? notional / lev : NaN;
    const liqMovePct = lev > 0 ? 100 / lev : NaN; // approx adverse % to wipe margin (ex-fees/MM)
    const fmtUsd = (x) => Number.isFinite(x) ? `$${Math.abs(x) >= 1 ? x.toFixed(2) : x.toPrecision(3)}` : "—";
    const cells = [
      ["Risk amount", fmtUsd(riskAmt), "warn"],
      ["Stop distance", `${stopPct.toFixed(2)}%`, ""],
      ["Target distance", tpValid ? `${tpPct.toFixed(2)}%` : "—", ""],
      ["Reward : Risk", Number.isFinite(rr) ? rr.toFixed(2) : "—", Number.isFinite(rr) && rr >= 2 ? "long" : "warn"],
      ["Position notional", fmtUsd(notional), "teal"],
      ["Quantity", Number.isFinite(qty) ? (qty >= 1 ? qty.toFixed(3) : qty.toPrecision(3)) : "—", ""],
      ["Est. PnL at TP", fmtUsd(pnlAtTp), "long"],
      ["Est. loss at SL", fmtUsd(lossAtSl), "short"],
      ["Suggested leverage", Number.isFinite(suggLev) ? `${suggLev}×` : "—", "teal"],
      ["Margin at " + (Number.isFinite(lev) ? lev + "×" : "—"), fmtUsd(margin), ""],
      ["Liq. move (approx)", Number.isFinite(liqMovePct) ? `~${liqMovePct.toFixed(1)}%` : "—", "warn"],
    ];
    let html = cells.map(([l, v, c]) =>
      `<div class="tout"><span class="tl">${esc(l)}</span><span class="tv ${c}">${esc(v)}</span></div>`).join("");
    out.innerHTML = html;
    const warnEl = $("#calcLevWarn");
    if (warnEl) warnEl.remove();
    if (Number.isFinite(levIn) && Number.isFinite(suggLev) && levIn > suggLev) {
      out.insertAdjacentHTML("afterend",
        `<div class="toolwarn" id="calcLevWarn">⚠ ${levIn}× exceeds the conservative ${suggLev}× hint for a ${stopPct.toFixed(2)}% stop. A stop-out near this leverage approaches liquidation — size down.</div>`);
    }
  }

  /* ====================================================================
   * POSITION HOLD/EXIT CHECKER — combines a held position with the latest
   * scan signal (when the symbol was scanned). Deterministic HOLD / REDUCE /
   * EXIT NOW / WATCH. Rule-based risk guidance, NOT financial advice.
   * ================================================================== */
  function positionEval() {
    const sym = (($("#posSym") || {}).value || "").trim().toUpperCase();
    const side = (($("#posSide") || {}).value) || "long";
    const entry = fnum("#posEntry"), cur = fnum("#posCur"), sl = fnum("#posSL"), tp = fnum("#posTP");
    if (!(entry > 0)) return { ok: false };
    const r = sym ? (state.results || []).find(x => x.sym.toUpperCase() === sym) : null;
    const price = cur > 0 ? cur : (r && r.mark) || entry;
    const dirSign = side === "long" ? 1 : -1;
    const pnlPct = (price - entry) / entry * 100 * dirSign;
    const reasons = [];
    let score = 0; // >0 favours hold, <0 favours exit
    const hitSL = sl > 0 && (side === "long" ? price <= sl : price >= sl);
    const hitTP = tp > 0 && (side === "long" ? price >= tp : price <= tp);
    let nearSL = false;
    if (sl > 0 && !hitSL) {
      const stopBand = Math.abs(entry - sl) / entry * 100;
      const dist = Math.abs(price - sl) / entry * 100;
      nearSL = stopBand > 0 && dist <= stopBand * 0.2;
    }
    if (hitSL) { reasons.push("price hit / passed stop loss"); score -= 100; }
    else if (nearSL) { reasons.push("price near stop loss"); score -= 40; }
    if (hitTP) { reasons.push("price reached take profit — book or trail"); score -= 30; }
    if (pnlPct <= -1) reasons.push(`position down ${pnlPct.toFixed(2)}%`);
    else if (pnlPct >= 1) { reasons.push(`position up ${pnlPct.toFixed(2)}%`); score += 8; }
    if (r) {
      const b = directionalBias(r);
      const v = validityFreshness(r);
      const biasSide = b.biasSide === "LONG" ? "long" : b.biasSide === "SHORT" ? "short" : "neu";
      const opp = biasSide !== "neu" && biasSide !== side;
      if (opp && b.biasConfidence >= 25) { reasons.push(`strong opposite scan bias ${b.longChance}/${b.shortChance}`); score -= 50; }
      else if (opp) { reasons.push(`mild opposite scan bias ${b.longChance}/${b.shortChance}`); score -= 20; }
      else if (biasSide === side) { reasons.push(`scan bias still ${biasSide.toUpperCase()} ${b.longChance}/${b.shortChance}`); score += 25; }
      if (v.validityStatus === "STALE" || v.validityStatus === "INVALID") { reasons.push(`setup validity ${v.validityStatus} ${v.validityPct}`); score -= 40; }
      else if (v.validityStatus === "FRESH" || v.validityStatus === "VALID") { reasons.push(`setup ${v.validityStatus} ${v.validityPct}`); score += 20; }
      if (r.dir && r.dir !== side) { reasons.push(`8-gate direction now ${r.dir.toUpperCase()} — against position`); score -= 30; }
      if (r.score8 < 8) { reasons.push(`gate score weakened to ${r.score8}/8`); score -= 12; }
    } else if (sym) {
      reasons.push("symbol not in latest scan — using price vs SL/TP only (run a scan for signal context)");
    }
    let verdict, vcls;
    if (hitSL || score <= -80) { verdict = "EXIT NOW"; vcls = "exit"; }
    else if (score <= -35) { verdict = "REDUCE"; vcls = "reduce"; }
    else if (hitTP) { verdict = "REDUCE"; vcls = "reduce"; reasons.unshift("TP reached — consider booking profit"); }
    else if (score >= 20 && !nearSL) { verdict = "HOLD"; vcls = "hold"; }
    else { verdict = "WATCH"; vcls = "watch"; }
    return { ok: true, verdict, vcls, reasons, sym, side, entry, cur: price, sl, tp, pnlPct, scanned: !!r };
  }
  function renderPosition() {
    const out = $("#posOut"); if (!out) return;
    const e = positionEval();
    if (!e.ok) {
      out.innerHTML = `<div class="verdict watch">ENTER DATA</div><ul class="verdictreasons"><li>Enter at least symbol, side, and entry price.</li></ul>`;
      return;
    }
    out.innerHTML = `<div class="verdict ${e.vcls}" data-testid="position-verdict">${e.verdict}</div>
      <ul class="verdictreasons">${e.reasons.map(t => `<li>${esc(t)}</li>`).join("")}</ul>
      <div class="brwhy" style="margin-top:9px">Rule-based risk guidance, not financial advice. No orders are placed. ${e.scanned ? "Combined with the latest scan signal." : "No scan row for this symbol — price-only check."}</div>`;
  }
  function positionExportText() {
    const e = positionEval();
    if (!e.ok) return "";
    return [
      "DELTA POSITION MONITOR REQUEST",
      `symbol: ${e.sym || "(none)"}`,
      `side: ${e.side.toUpperCase()}`,
      `entry: ${e.entry}`,
      `current: ${e.cur}`,
      `stop_loss: ${e.sl > 0 ? e.sl : "-"}`,
      `take_profit: ${e.tp > 0 ? e.tp : "-"}`,
      `current_verdict: ${e.verdict}`,
      `pnl_pct: ${e.pnlPct.toFixed(2)}`,
      "exit_rules: EXIT/REDUCE if price hits the stop, the 8-gate scanner bias turns strongly opposite, setup validity goes STALE/INVALID, the scanner direction flips against this side, or loss exceeds planned risk. HOLD while bias/validity align and price has not hit SL/TP.",
      "note: rule-based guidance only; this app places no orders and stores no private Delta credentials. Email exit alerts must run from the separate scheduled Perplexity monitor using these details.",
    ].join("\n");
  }

  /* ====================================================================
   * OUTCOME LAB / EXPECTANCY — reads measured triple-barrier outcomes from
   * the backend. Below N=30 resolved trades the verdict is provisional.
   * Pure data — no orders. Backend resolves against public candles only.
   * ================================================================== */
  function olRow(label, value, cls) {
    return `<div class="tout"><span class="tl">${esc(label)}</span><span class="tv ${cls || ""}">${esc(value)}</span></div>`;
  }
  function olFmtR(x) {
    if (x == null || !Number.isFinite(+x)) return "—";
    const v = +x;
    return (v >= 0 ? "+" : "") + v.toFixed(3) + "R";
  }
  function renderOutcomeLabData(e) {
    const out = $("#olOut"); if (!out) return;
    if (!e || e.ok === false) {
      out.innerHTML = olRow("Status", (e && e.error) ? e.error : "No data yet", "warn");
      return;
    }
    const ready = !!e.verdict_ready;
    const diff = e.structural_minus_fixed_R;
    const diffCls = diff == null ? "" : (diff > 0 ? "long" : diff < 0 ? "short" : "");
    const wr = ready ? e.win_rate : e.win_rate_provisional;
    const cells = [
      olRow("Total logged", e.total != null ? e.total : "—", "teal"),
      olRow("Open", e.open != null ? e.open : "—", ""),
      olRow("Closed (resolved)", e.closed != null ? e.closed : "—", ""),
      olRow("Min N for verdict", e.min_n != null ? e.min_n : "—", ""),
      olRow("Verdict ready", ready ? "YES" : "NO — provisional", ready ? "long" : "warn"),
      olRow("Structural expectancy", olFmtR(e.structural_expectancy_R), "teal"),
      olRow("Fixed 2R expectancy", olFmtR(e.fixed_expectancy_R), ""),
      olRow("Structural − Fixed", olFmtR(diff), diffCls),
      olRow(ready ? "Win rate" : "Win rate (provisional)",
        wr == null ? "—" : (wr * 100).toFixed(1) + "%", ready ? "" : "warn"),
      olRow("Paired A/B sample", e.paired_n != null ? e.paired_n : "—", ""),
    ];
    // Grouped expectancy: which independent SIGNALS carry edge (req #1/#2/#5),
    // not the old correlated gate count. Each block summarizes by a real signal.
    const grpRows = (title, obj) => {
      const m = obj || {};
      const keys = Object.keys(m);
      if (!keys.length) return [];
      return keys.map(k => {
        const s = m[k] || {};
        const r = s.structural_expectancy_R != null ? s.structural_expectancy_R : s.fixed_expectancy_R;
        const cls = r == null ? "" : (r > 0 ? "long" : r < 0 ? "short" : "");
        return olRow(title + " · " + k.replace(/_/g, " ") + " (n=" + (s.n || 0) + ")", olFmtR(r), cls);
      });
    };
    const famRows = grpRows("Family", e.by_family);
    const sigRows = grpRows("Funding signal", e.by_funding_signal);
    const stateRows = grpRows("Funding state", e.by_funding_state);
    const groupRows = grpRows("Exposure group", e.by_group);
    // Loud provisional/unvalidated banner until N reaches min_n (req #5).
    const banner = ready
      ? `<div class="brwhy" style="margin-top:9px;color:var(--long)">Verdict ready — ${e.closed} resolved trades.</div>`
      : `<div class="hswarn" style="margin-top:9px">⚠ UNVALIDATED — ${e.closed || 0}/${e.min_n || "?"} resolved trades. Expectancy is provisional; the model is NOT yet validated. Do not treat these numbers as edge.</div>`;
    out.innerHTML = cells.join("") +
      famRows.join("") + sigRows.join("") + stateRows.join("") + groupRows.join("") +
      banner +
      `<div class="brwhy" style="margin-top:9px">${esc(e.note || "")}</div>`;
  }
  async function refreshOutcomeLab() {
    const out = $("#olOut");
    if (out) out.innerHTML = olRow("Status", "Loading…", "");
    try {
      const res = await fetch(API_BASE + "/api/tradelog/expectancy", { method: "GET" });
      const j = await res.json();
      renderOutcomeLabData(j);
    } catch (e) {
      renderOutcomeLabData({ ok: false, error: "Backend unreachable — run `npm start`." });
    }
  }
  async function resolveOutcomeLab(btn) {
    const feed = $("#olFeed");
    if (btn) { btn.disabled = true; btn.textContent = "Resolving…"; }
    try {
      const res = await fetch(API_BASE + "/api/tradelog/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await res.json();
      if (j && j.ok) {
        const r = j.resolved || {};
        if (feed) feed.textContent = `Resolved ${r.resolved || 0} of ${r.checked || 0} open (${r.errors || 0} unresolved/no-data).`;
        if (j.expectancy) renderOutcomeLabData(j.expectancy); else refreshOutcomeLab();
      } else {
        if (feed) feed.textContent = (j && j.error) ? j.error : "Resolve failed.";
      }
    } catch (e) {
      if (feed) feed.textContent = "Backend unreachable — run `npm start` to resolve.";
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Resolve open setups"; }
    }
  }

  /* Evaluate one symbol -> result mirroring the Python result dict + gate_list */
  function evalSymbol(sym, scanSeed) {
    const r = rng(hash(sym + "|" + scanSeed));
    const px = BASE_PX[sym] || 10;
    const turnover = Math.round((5e5 + r() * 9e7));
    const dir = r() > 0.5 ? "long" : "short";
    const sign = dir === "long" ? 1 : -1;

    // 4-family quality score /100 (biased high enough that a useful share clears the floor)
    const score4 = Math.round(60 + r() * 40);
    const famLong = Math.max(0, Math.min(4, score4 >= 75 ? 4 : Math.round((score4 - 8) / 23)));

    // MTF agreement
    const tfs = String(params.mtf_timeframes).split(",").map(s=>s.trim()).filter(Boolean);
    const entryTf = params.entry_tf;
    const nTf = tfs.includes(entryTf) ? tfs.length : tfs.length + 1;
    const mtfAgree = r() > 0.32 ? nTf : nTf - 1 - Math.floor(r()*2);

    // RSI
    const rsi = +(38 + r() * 26).toFixed(1);
    const rsiThr = dir === "long"
      ? (params.rsi_adapt === "trend" ? 30 : params.rsi_lo)
      : (params.rsi_adapt === "trend" ? 70 : params.rsi_hi);
    const rsiClean = dir === "long" ? rsi > params.rsi_lo && rsi < params.rsi_hi
                                    : rsi > params.rsi_lo && rsi < params.rsi_hi;

    // funding (%)
    const fund = +(((r() - 0.5) * 0.11) * params.funding_mult).toFixed(4);
    const block = params.funding_block_pct;
    const fundingClean = Math.abs(fund) <= block && (sign > 0 ? fund <= block : fund >= -block);

    // judas sweep
    const judasOk = r() > 0.3;

    // cusum
    const cusumDir = (sign > 0 ? r() > 0.3 : r() < 0.7) ? "UP" : "DOWN";
    const cusumAlign = (dir === "long" && cusumDir === "UP") || (dir === "short" && cusumDir === "DOWN");

    // structural SL / TP / RR
    const atrPct = (0.5 + r() * 1.6) * (params.atr_dynamic === "vol" ? (0.8 + r()*0.6) : 1) * params.atr_mult / 1.5;
    const slPct = +(atrPct).toFixed(2);
    const entry = px * (1 + (r()-0.5)*0.001);
    const stop = dir === "long" ? entry * (1 - slPct/100) : entry * (1 + slPct/100);
    const rrTarget = params.rr_target;
    const rrActual = +(rrTarget * (0.92 + r()*0.45)).toFixed(1);
    const target = dir === "long" ? entry * (1 + (slPct*rrActual)/100) : entry * (1 - (slPct*rrActual)/100);
    const structOk = rrActual >= rrTarget && stop > 0;

    // liquidity / price
    const liqOk = turnover >= params.min_turnover && px > 0;

    const familyQuality = famLong >= 4 && score4 >= params.family_score_floor;
    const mtfCascade = mtfAgree === nTf && nTf > 0;

    const gateMap = {
      FAMILY_QUALITY: familyQuality,
      MTF_CASCADE: mtfCascade,
      RSI_CLEAN: rsiClean,
      FUNDING_CLEAN: fundingClean,
      JUDAS_SWEEP: judasOk,
      CUSUM_ALIGN: cusumAlign,
      STRUCTURAL_RR_SL: structOk,
      LIQUIDITY_PRICE: liqOk,
    };
    const gateList = GATES.map(g => gateMap[g.key]);
    const score8 = gateList.filter(Boolean).length;
    const passed = score8 === 8;

    // synthesize a current/mark price that drifts from the reference entry so
    // the execution-zone logic (ideal / acceptable / chase / invalidated) is
    // exercised in demo mode. Drift is a fraction of the stop distance.
    const stopDist = Math.abs(entry - stop) || (entry * slPct / 100) || 1e-9;
    const driftR = (r() - 0.42) * 1.4; // ~ -0.59R .. +0.96R in favor/against
    const favorDir = dir === "long" ? 1 : -1;
    const mark = entry + favorDir * driftR * stopDist;
    const entryDeltaPct = entry ? (mark - entry) / entry * 100 : 0;
    // ---- confirmatory-layer demo synthesis (clearly preview-only) ----
    const volRatio = +(0.6 + r() * 1.4).toFixed(2);          // 0.6x..2.0x average
    const oi = Math.round(2e6 + r() * 9e7);                   // demo open interest
    const ema50d = entry * (1 + (sign > 0 ? -1 : 1) * (0.002 + r() * 0.02));
    const vwapd = entry * (1 + (sign > 0 ? -1 : 1) * (0.001 + r() * 0.015));
    const vwapLoc = mark > vwapd ? "above" : mark < vwapd ? "below" : "at";
    const emaLoc = mark > ema50d ? "above" : mark < ema50d ? "below" : "at";
    const liqQuality = turnover >= 5e6 ? "ok" : turnover >= 1e6 ? "moderate" : "thin";
    return {
      sym, dir, entry, stop, target, rr: rrActual, slPct, tpPct: +(slPct*rrActual).toFixed(2),
      score8, score4, famLong, mtfAgree, nTf, rsi, rsiThr, cusumDir,
      cusumScore: +(1 + r() * 2).toFixed(2), fund, judasOk,
      turnover, gateMap, gateList, passed,
      mark, entryDeltaPct,
      oi, oiUsd: oi, volRatio, vwap: vwapd, vwapLoc, emaLoc, ema50: ema50d, liqQuality,
      above50: r() > 0.5,
    };
  }

  /* ---------- backend (live Delta public data) ---------- */
  // The backend serves the static app AND exposes /api/scan + /api/health.
  // `__PORT_8000__` is replaced by deploy_website with the proxy path; during
  // local testing it stays as the placeholder and we fall back to same-origin
  // relative URLs (the Express server hosts both the app and the API).
  const PORT_TOKEN = "__PORT_8000__";
  const API_BASE = PORT_TOKEN.charAt(0) === "_" ? "" : PORT_TOKEN; // "" => same-origin
  // Allow turning the backend off entirely (debug); default is backend-first.
  const USE_BACKEND = true;

  // Normalize a backend result row into the shape the UI renderers expect.
  function normalizeRow(r, i) {
    const gateMap = {};
    if (r.gates) {
      GATES.forEach(g => { gateMap[g.key] = !!r.gates[g.key]; });
    } else if (Array.isArray(r.gateList)) {
      GATES.forEach((g, idx) => { gateMap[g.key] = !!r.gateList[idx]; });
    }
    const gateList = Array.isArray(r.gateList) ? r.gateList.map(Boolean) : GATES.map(g => !!gateMap[g.key]);
    const score8 = (Number.isFinite(r.score8)) ? r.score8 : gateList.filter(Boolean).length;
    return {
      sym: r.sym, dir: r.dir || "long",
      entry: r.entry, stop: r.stop, target: r.target,
      rr: Number.isFinite(r.rr) ? r.rr : params.rr_target,
      slPct: Number.isFinite(r.slPct) ? r.slPct : 0,
      tpPct: Number.isFinite(r.tpPct) ? r.tpPct : 0,
      score8, score4: r.score4 || 0, famLong: r.famLong || 0,
      mtfAgree: r.mtfAgree || 0, nTf: r.nTf || 0,
      rsi: Number.isFinite(r.rsi) ? r.rsi : 0,
      rsiThr: Number.isFinite(r.rsiThr) ? r.rsiThr : 50,
      cusumDir: r.cusumDir || "FLAT",
      cusumScore: Number.isFinite(r.cusumScore) ? r.cusumScore : 1,
      fund: Number.isFinite(r.fund) ? r.fund : 0,
      judasOk: !!r.judasOk, turnover: r.turnover || 0,
      gateMap, gateList, passed: r.passed != null ? !!r.passed : score8 === 8,
      // live current/mark price for execution validation (falls back to entry)
      mark: Number.isFinite(r.mark) ? r.mark : (Number.isFinite(r.price) ? r.price : r.entry),
      entryDeltaPct: Number.isFinite(r.entryDeltaPct) ? r.entryDeltaPct : 0,
      stretched: !!r.stretched, priceDiv: !!r.priceDiv,
      // ---- confirmatory-layer fields (null when the source is absent) ----
      oi: Number.isFinite(r.oi) ? r.oi : null,
      oiUsd: Number.isFinite(r.oiUsd) ? r.oiUsd : null,
      volRatio: Number.isFinite(r.volRatio) ? r.volRatio : null,
      vwap: Number.isFinite(r.vwap) ? r.vwap : null,
      vwapLoc: r.vwapLoc || null,
      emaLoc: r.emaLoc || null,
      ema50: Number.isFinite(r.ema50) ? r.ema50 : null,
      liqQuality: r.liqQuality || null,
      // deterministic-but-stable "above 50EMA" proxy for the heat bias widget
      above50: r.cusumDir ? r.cusumDir === "UP" : (i % 2 === 0),
    };
  }

  async function fetchBackendScan() {
    const payload = Object.assign({}, params, { strict: state.strict });
    const res = await fetch(API_BASE + "/api/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("backend HTTP " + res.status);
    const data = await res.json();
    if (!data || data.ok === false || !Array.isArray(data.results)) {
      throw new Error((data && data.error) || "backend returned no data");
    }
    return data;
  }

  // Deterministic demo fallback (clearly labelled). Returns rows only.
  function demoScan() {
    const max = Math.min(params.max_symbols, SYMBOLS.length);
    let univ = SYMBOLS.slice(0, max);
    if (params.quote_filter) univ = univ.filter(s => s.endsWith(params.quote_filter));
    const run = (seed) => univ.map(s => evalSymbol(s, seed));
    if (!state.firstScanDone) {
      state.firstScanDone = true;
      let best = null, bestP = -1;
      for (let seed = 1; seed < 12000; seed++) {
        const out = run(seed);
        const p = out.filter(r => r.passed).length;
        if (p >= 3 && p <= 4) return out;
        if (p > bestP) { bestP = p; best = out; }
      }
      if (best) return best;
    }
    return run(Math.floor(Date.now() / 1000));
  }

  // Deterministic demo BTC/ETH market regime (clearly preview-only).
  function demoRegime() {
    const seed = state.firstScanDone ? Math.floor(Date.now() / 6e4) : 7;
    const rr = rng(hash("regime|" + seed));
    const dir = rr() > 0.5 ? "UP" : "DOWN";
    const score = +(0.8 + rr() * 2.4).toFixed(2);
    return {
      available: true, tf: params.entry_tf || "15m", bias: dir, strength: score,
      btc: { sym: "BTCUSD", dir, score },
      eth: { sym: "ETHUSD", dir: rr() > 0.35 ? dir : (dir === "UP" ? "DOWN" : "UP"), score: +(0.6 + rr() * 2).toFixed(2) },
    };
  }

  // Returns { results, live, note, marketRegime }.
  async function fetchScan() {
    if (USE_BACKEND) {
      try {
        const data = await fetchBackendScan();
        const results = data.results.map(normalizeRow);
        return {
          results, live: true,
          marketRegime: (data.market_regime && typeof data.market_regime === "object") ? data.market_regime : null,
          report: typeof data.report === "string" ? data.report : "",
          note: `${data.data_source || "LIVE DELTA PUBLIC DATA"} · ${(data.summary && data.summary.universe) || results.length} symbols · ${(data.summary && data.summary.took_ms) || "?"}ms`,
        };
      } catch (e) {
        return {
          results: demoScan(), live: false,
          marketRegime: demoRegime(),
          note: "Backend unavailable (" + (e.message || e) + ") — showing deterministic DEMO data.",
        };
      }
    }
    return { results: demoScan(), live: false, marketRegime: demoRegime(), note: "Demo mode (backend disabled)." };
  }

  /* ---------- exact terminal report (mirrors print_report) ---------- */
  function buildReport(results, kept) {
    const now = new Date().toISOString().slice(11, 16);
    const crit = state.strict ? "clean (4-family)" : "watch (3+/4 non-strict)";
    let out = `<span class="rhead">DELTA SCANNER v6 — ${now} UTC</span>\n`;
    out += `<span class="rcount">${kept.length} setup(s) passed ${crit}</span>\n`;
    out += `<span class="ln">${"=".repeat(48)}</span>\n\n`;
    const brl = bestReportLine(results);
    if (brl) out += `<span class="rcount">${esc(brl)}</span>\n\n`;
    if (!kept.length) out += `<span class="ln">(no qualifying setups this scan)</span>\n\n`;
    kept.forEach(r => {
      const d = r.dir.toUpperCase();
      const gates = r.gateList.map(g => g ? "Y" : "N").join(" ");
      out += `${esc(r.sym)} ${d}  Score:${r.score8}/8\n`;
      out += `Entry:$${fmtPrice(r.entry)}  SL:$${fmtPrice(r.stop)}(${r.slPct.toFixed(2)}%)  TP:$${fmtPrice(r.target)}(${r.tpPct.toFixed(2)}%)  RR:${r.rr.toFixed(1)}\n`;
      out += `Fam:${r.famLong}/4 MTF:${r.mtfAgree}/${r.nTf} RSI:${r.rsi.toFixed(1)}/${r.rsiThr.toFixed(1)} CUSUM:${r.cusumDir} FR:${r.fund.toFixed(4)}%\n`;
      out += `Judas:${r.judasOk ? "YES" : "NO"} Gates:${gates}\n`;
      const b = directionalBias(r);
      const v = validityFreshness(r);
      out += `Bias: ${b.biasSide} ${b.longChance}/${b.shortChance} (${b.biasLabel}) · Validity: ${v.validityStatus} ${v.validityPct}\n\n`;
    });
    // ---- Formation Radar sections (context only; verdict unchanged) ----
    const keptSet = new Set(kept.map(r => r.sym));
    const near = results.filter(r => r.dir && r.score8 === 7 && !keptSet.has(r.sym))
      .sort((a, b) => b.score4 - a.score4);
    const forming = results.filter(r => r.dir && (r.score8 === 5 || r.score8 === 6) && !keptSet.has(r.sym))
      .sort((a, b) => (b.score8 - a.score8) || (b.score4 - a.score4));
    const compact = (r) => {
      const miss = GATES.filter(g => !r.gateMap[g.key]).map(g => g.label).join(", ") || "—";
      const b = directionalBias(r);
      const v = validityFreshness(r);
      return `${esc(r.sym)} ${r.dir.toUpperCase()} ${r.score8}/8 · bias: ${b.biasSide[0]} ${b.longChance}/${b.shortChance} · val: ${v.validityStatus} ${v.validityPct} · miss: ${miss}`;
    };
    if (near.length) {
      out += `<span class="ln">${"-".repeat(48)}</span>\n`;
      out += `<span class="rcount">NEAR (7/8 — one gate away) · ${near.length}</span>\n`;
      near.forEach(r => { out += compact(r) + "\n"; });
      out += "\n";
    }
    if (forming.length) {
      out += `<span class="ln">${"-".repeat(48)}</span>\n`;
      out += `<span class="rcount">FORMING (5-6/8 — watchlist) · ${forming.length}</span>\n`;
      forming.slice(0, 25).forEach(r => { out += compact(r) + "\n"; });
      if (forming.length > 25) out += `<span class="ln">… +${forming.length - 25} more</span>\n`;
    }
    return out.replace(/\n$/,"");
  }
  function esc(s){ return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  /* ---------- Formation Radar list (near-forming + forming watch) ---------- */
  function formationRowHTML(r) {
    const fm = formation(r);
    const d = r.dir;
    const miss = fm.missing.map(g => g.label).join(", ") || "—";
    const why = fm.whyWatch.join(", ") || "—";
    const emailBadge = fm.emailEligible
      ? `<span class="emailbadge" title="Matches the scheduled scanner's email-eligible criteria — no email sent from this app">✉ Email-eligible</span>` : "";
    return `<div class="frrow ${d}" data-testid="formation-row-${esc(r.sym)}">
      <div class="frtop">
        <span class="sym">${esc(r.sym)}</span>
        <span class="dir ${d}">${d.toUpperCase()}</span>
        <span class="frlabel ${fm.meta.cls}">${esc(fm.meta.label)}</span>
        ${emailBadge}
        <span class="frready">${esc(fm.readiness)}</span>
      </div>
      ${biasBarHTML(r, { chips: false })}
      ${validityBarHTML(r, { chips: false })}
      <div class="frmiss">Missing: <b>${esc(miss)}</b></div>
      <div class="frwhy">Why watch: <b>${esc(why)}</b></div>
    </div>`;
  }
  function renderFormationRadar(results) {
    const el = $("#formationRadar");
    if (!el) return;
    if (!results.length) {
      el.innerHTML = `<div class="empty"><span class="big">Radar idle</span>Near-forming (7/8) and forming (5–6/8) coins appear here after a scan.</div>`;
      return;
    }
    const near = results.filter(r => r.dir && r.score8 === 7).sort((a,b)=>b.score4-a.score4);
    const forming = results.filter(r => r.dir && (r.score8 === 5 || r.score8 === 6))
      .sort((a,b)=>(b.score8-a.score8)||(b.score4-a.score4)).slice(0, 25);
    if (!near.length && !forming.length) {
      el.innerHTML = `<div class="empty"><span class="big">Nothing forming</span>No coin is within two gates of strict 8/8 this scan.</div>`;
      return;
    }
    let html = "";
    if (near.length) {
      html += `<div class="frgroup"><div class="frgh">Near — 7/8 · one gate away <span class="cnt">${near.length}</span></div>`;
      html += near.map(formationRowHTML).join("") + `</div>`;
    }
    if (forming.length) {
      html += `<div class="frgroup"><div class="frgh">Forming — 5–6/8 watchlist <span class="cnt">${forming.length}</span></div>`;
      html += forming.map(formationRowHTML).join("") + `</div>`;
    }
    el.innerHTML = html;
  }

  /* ---------- setup card ---------- */
  // Honest summary strip (req #3): a small set of non-correlated, non-probability
  // labels that lead the card — core family pass/fail, setup state, execution
  // status, plus beta/funding context. Prefers additive backend fields; falls
  // back to client computation so older cached scan responses still render.
  function honestSummaryHTML(r) {
    // Core family pass/fail (4-family honest model, not 8 correlated gates).
    const famScore = Number.isFinite(+r.familyScore) ? +r.familyScore
      : (Number.isFinite(+r.famLong) ? +r.famLong : null);
    const corePass = (typeof r.corePass === "boolean") ? r.corePass : (r.score8 === 8);
    const coreCls = corePass ? "ok" : (famScore != null && famScore >= 3 ? "warn" : "bad");
    const coreTxt = famScore != null ? `${famScore}/4` : "—";
    // Setup state (formation/validity), not a probability.
    const stateTxt = r.setupState || (typeof formation === "function" ? (formation(r).label || "—") : "—");
    // Execution status: backend ENTER/WAIT/AVOID, else client execStatus mapping.
    let execTxt, execCls;
    if (r.executionStatus) {
      execTxt = r.executionStatus;
      execCls = r.executionStatus === "ENTER" ? "ok" : r.executionStatus === "WAIT" ? "warn" : "bad";
    } else {
      const es = execStatus(r);
      const m = EXEC_STATUS_META[es.code] || {};
      execTxt = (m.action || es.code || "—");
      execCls = m.cls === "ok" ? "ok" : m.cls === "bad" ? "bad" : "warn";
    }
    // Beta / funding context (req #5/#6) — surfaced, not buried.
    const beta = r.betaGate ? `<span class="hs ${r.betaGate==="ok"?"ok":r.betaGate==="block"?"bad":"warn"}">BTC beta <b>${esc(r.betaGate)}</b></span>` : "";
    // Funding as a SIGNAL (req #3): show crowding state + per-direction signal
    // (favor/against/neutral/veto), not a binary clean veto.
    const fundTxt = r.fundingState ? r.fundingState.replace(/_/g, " ") : "";
    const sig = r.fundingSignal || null;
    const sigCls = sig === "favor" ? "ok" : sig === "against" || sig === "veto" ? "bad" : "";
    const fund = fundTxt
      ? `<span class="hs ${sigCls}" title="Funding/crowding signal for this direction">Funding <b>${esc(fundTxt)}</b>${sig?` → <b>${esc(sig)}</b>`:""}</span>`
      : "";
    const grp = r.correlatedExposureGroup ? `<span class="hs" title="Correlated exposure group — size as one position">Group <b>${esc(r.correlatedExposureGroup)}</b></span>` : "";
    const tgtMode = r.targetMode === "structural_first" || r.targetMode === "structural" ? "structural" : "fixed";
    const tgt = r.targetMode ? `<span class="hs" title="Target mode">Target <b>${esc(tgtMode)}</b></span>` : "";
    // BTC-beta basket warning (req #4): correlated alt exposure surfaced loudly.
    const warn = r.correlatedExposureWarning
      ? `<div class="hswarn" title="Correlated BTC-beta exposure">⚠ ${esc(r.correlatedExposureWarning)}</div>`
      : "";
    // 4-family honest verdict (CLEAN/WATCH/SKIP) — the rollup the backend computes.
    // Leads the strip when present; falls back to silence for older cached responses.
    const vCls = r.honestVerdict === "CLEAN" ? "ok" : r.honestVerdict === "WATCH" ? "warn" : "bad";
    const verdict = r.honestVerdict
      ? `<span class="hs ${vCls}" title="4-family honest verdict — not a probability">Verdict <b>${esc(r.honestVerdict)}</b></span>`
      : "";
    return `<div class="honest" data-testid="honest-${esc(r.sym)}">
      ${verdict}
      <span class="hs ${coreCls}">Core <b>${coreTxt}</b> ${corePass?"PASS":"—"}</span>
      <span class="hs">Setup <b>${esc(stateTxt)}</b></span>
      <span class="hs ${execCls}">Exec <b>${esc(execTxt)}</b></span>
      ${beta}${fund}${grp}${tgt}
      <span class="hsnote">non-probability labels</span>
      ${warn}
    </div>`;
  }

  function cardHTML(r) {
    const d = r.dir;
    const full = r.score8 === 8;
    const sizeUnits = (params.account_size * params.risk_pct / 100) / Math.max(1e-9, Math.abs(r.entry - r.stop));
    const riskAmt = params.account_size * params.risk_pct / 100;
    const gatesHTML = GATES.map(g => {
      const ok = r.gateMap[g.key];
      return `<span class="gate ${ok?"pass":"fail"}"><i></i>${g.label}</span>`;
    }).join("");
    // session state badge (new/seen/sent) for duplicate-alert protection
    const st = setupState(r);
    const stLabel = st === "sent" ? "Sent" : st === "seen" ? "Seen" : "New";
    const stateBadge = `<span class="statebadge ${st}" title="Session state">${stLabel}</span>`;
    // Strategy Match grade badge (rule-based)
    const sm = strategyMatch(r);
    const gradeBadge = `<span class="gradebadge ${sm.meta.cls}" title="Strategy Match grade" data-testid="grade-badge-${esc(r.sym)}">${esc(sm.grade)}</span>`;
    const fm = formation(r);
    const emailBadge = fm.emailEligible
      ? `<span class="emailbadge" title="Matches the scheduled scanner's email-eligible criteria — no email sent from this app" data-testid="email-badge-${esc(r.sym)}">✉ Email-eligible</span>`
      : "";
    return `<div class="card ${d} ${full?"pass":""}">
      <div class="crow1">
        <span class="sym">${esc(r.sym)}</span>
        <span class="dir ${d}">${d.toUpperCase()}</span>
        ${gradeBadge}
        ${stateBadge}
        ${emailBadge}
        <span class="scorebadge ${full?"full":"part"}">Score ${r.score8}/8 <span class="sb"><i style="width:${r.score8/8*100}%"></i></span></span>
      </div>
      ${honestSummaryHTML(r)}
      ${biasBarHTML(r, { chips: true })}
      ${validityBarHTML(r, { chips: true })}
      <div class="levels">
        <span class="lk"><span class="lt">Entry</span><span class="lv e">$${fmtPrice(r.entry)}</span></span>
        <span class="lk"><span class="lt">Stop</span><span class="lv s">$${fmtPrice(r.stop)} <small style="color:var(--dim2)">${r.slPct.toFixed(2)}%</small></span></span>
        <span class="lk"><span class="lt">Target</span><span class="lv t">$${fmtPrice(r.target)} <small style="color:var(--dim2)">${r.tpPct.toFixed(2)}%</small></span></span>
        <span class="lk"><span class="lt">R:R</span><span class="lv rr">${r.rr.toFixed(1)}</span></span>
        <span class="lk"><span class="lt">Size @ ${params.risk_pct}%</span><span class="lv">${sizeUnits>=1?sizeUnits.toFixed(2):sizeUnits.toPrecision(3)} <small style="color:var(--dim2)">$${riskAmt.toFixed(0)} risk</small></span></span>
      </div>
      <div class="meta">
        <span class="m">Fam <b>${r.famLong}/4</b></span>
        <span class="m">MTF <b>${r.mtfAgree}/${r.nTf}</b></span>
        <span class="m">RSI <b>${r.rsi.toFixed(1)}</b>/${r.rsiThr.toFixed(1)}</span>
        <span class="m ${r.cusumDir==="UP"?"up":"down"}">CUSUM <b>${r.cusumDir}</b></span>
        <span class="m">FR <b>${r.fund.toFixed(4)}%</b></span>
        ${r.judasOk?'<span class="m judas">Judas <b>YES</b></span>':'<span class="m">Judas <b style="color:var(--short)">NO</b></span>'}
      </div>
      <div class="gates">${gatesHTML}</div>
      ${strategyPanelHTML(r)}
      ${confirmatoryPanelHTML(r)}
      ${qualityPanelHTML(r)}
      ${executionPanelHTML(r)}
      <div class="act">
        ${full ? `<button class="go" data-act="plan" data-sym="${esc(r.sym)}">${planLabel()}</button>` : `<button disabled>Below 8/8 — locked</button>`}
        <button class="ghost" data-act="copy" data-sym="${esc(r.sym)}" data-testid="button-copy-setup">⧉ Copy setup</button>
        <button class="ghost" data-act="alert" data-sym="${esc(r.sym)}">Log alert</button>
      </div>
    </div>`;
  }
  // Setup Quality panel: 0-100 CHECKLIST read (NOT a probability / win rate).
  // Component bars show which solid signals are present. Target-style label is
  // a checklist descriptor only.
  function qualityPanelHTML(r) {
    const q = qualityScore(r);
    const comps = qualityComponents(r);
    const conf = targetConfidence(r, q);
    const win = expectedWindow(r, q);
    const col = qcolor(q);
    const bars = comps.map(c => `<span class="qb"><span>${c.label}</span><span class="qbm"><i style="width:${Math.round(c.n*100)}%;background:${col}"></i></span><b>${Math.round(c.n*100)}</b></span>`).join("");
    const winHTML = win ? `<div class="qwindow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>${esc(win)}</div>` : "";
    return `<div class="qpanel">
      <div class="qtitle">Setup Quality <small>checklist score · not a probability or win rate</small></div>
      <div class="qhead">
        <span class="qscore" style="color:${col}" data-testid="text-quality-${esc(r.sym)}">${q}<small>/100</small></span>
        <span class="qmeter"><i style="width:${q}%;background:${col}"></i></span>
        <span class="qconf ${conf.toLowerCase()}">${conf} target</span>
      </div>
      <div class="qbars">${bars}</div>
      ${winHTML}
    </div>`;
  }

  /* ---------- Strategy Match panel (per setup) ---------- */
  function strategyPanelHTML(r) {
    const sm = strategyMatch(r);
    const m = sm.meta;
    const chipsHTML = sm.chips.map(c =>
      `<span class="smchip ${c.k}">${esc(c.t)}</span>`).join("");
    const mult = sm.sizeMult;
    const multPct = Math.min(100, Math.round(mult * 100));
    const profileNote = activeProfile().label;
    return `<div class="smpanel ${m.cls}" data-testid="strategy-panel-${esc(r.sym)}">
      <div class="smhead">
        <span class="smgrade ${m.cls}" data-testid="strategy-grade-${esc(r.sym)}">${esc(sm.grade)}</span>
        <span class="smtag">${esc(m.tag)}</span>
        <span class="smprofile">${esc(profileNote)}</span>
      </div>
      <div class="smaction ${m.cls}" data-testid="strategy-action-${esc(r.sym)}">${esc(sm.action)}</div>
      <div class="smsize">
        <span class="smk">Size</span>
        <span class="smbar"><i style="width:${multPct}%"></i></span>
        <span class="smv" data-testid="strategy-size-${esc(r.sym)}">${esc(sm.sizeNote)}</span>
      </div>
      <div class="smchips">${chipsHTML}</div>
      <div class="smwhy">Rule-based checklist — ${esc(sm.why)}. Not a probability, win rate, or financial advice.</div>
    </div>`;
  }

  /* ---------- Confirmatory Signal panel (per setup) ---------- */
  function confirmatoryPanelHTML(r) {
    const cf = confirmatory(r);
    const m = cf.meta;
    const compRows = [
      ["BTC / market regime", cf.comps.regime],
      ["Funding pressure", cf.comps.funding],
      ["Open interest", cf.comps.oi],
      ["Volume confirmation", cf.comps.volume],
      ["VWAP / EMA location", cf.comps.vwap],
      ["Judas / retest", cf.comps.retest],
      ["Liquidity quality", cf.comps.liq],
      ["Event / news risk", cf.comps.event],
    ];
    const kCls = { pos: "pos", neg: "neg", warn: "warn", na: "na" };
    const rowsHTML = compRows.map(([label, c]) =>
      `<div class="cfrow"><span class="cfk">${esc(label)}</span><span class="cfv ${kCls[c.k]}">${esc(c.chip)}</span></div>`
    ).join("");
    const chipsHTML = cf.chips.map(c =>
      `<span class="cfchip ${kCls[c.k]}">${esc(c.chip)}</span>`).join("");
    return `<div class="cfpanel ${m.cls}" data-testid="confirm-panel-${esc(r.sym)}">
      <div class="cftitle">Confirmatory Signal <small>rule-based confirm/reduce/block · not a probability or win rate</small></div>
      <div class="cfhead">
        <span class="cfstatus ${m.cls}" data-testid="confirm-status-${esc(r.sym)}">${esc(cf.status)} · ${esc(m.label)}</span>
        <span class="cfaction ${m.cls}">${esc(m.action)}</span>
      </div>
      <div class="cfsize">
        <span class="cfk">Size adj</span>
        <span class="cfv" data-testid="confirm-size-${esc(r.sym)}">${esc(cf.sizeNote)}</span>
        <span class="cfcombined">combined ≈ ${cf.combinedMult.toFixed(2)}×</span>
      </div>
      <div class="cfgrid">${rowsHTML}</div>
      <div class="cfchips">${chipsHTML}</div>
      <div class="cfwhy">Confirms or reduces/blocks <b>after</b> 8/8 + Strategy Match — ${esc(cf.why)}. Deterministic checklist, never a prediction.</div>
    </div>`;
  }

  // SVG glyphs for the execution status pill.
  function execIcon(kind) {
    const w = 'width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
    if (kind === "check") return `<svg ${w}><path d="M20 6 9 17l-5-5"/></svg>`;
    if (kind === "clock") return `<svg ${w}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
    if (kind === "alert") return `<svg ${w}><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"/></svg>`;
    return `<svg ${w}><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>`; // x
  }

  /* ---------- Execution Strategy panel (per setup) ---------- */
  function executionPanelHTML(r) {
    const st = execStatus(r);
    const meta = EXEC_STATUS_META[st.code];
    const plan = execPlan(r);
    const sz = positionSizing(r);
    const cur = (Number.isFinite(r.mark) && r.mark > 0) ? r.mark : r.entry;
    const delta = r.entry ? (cur - r.entry) / r.entry * 100 : 0;
    const fR = favorR(r);
    const deltaSign = delta >= 0 ? "+" : "";
    const dirWord = r.dir === "long" ? "above" : "below";
    const favorWord = fR >= 0 ? "in favor" : "against";

    // Entry-zone meter: map -0.85R..+1R to 0..100% with marked bands.
    const zonePct = Math.max(0, Math.min(100, ((fR + 0.85) / 1.85) * 100));
    const zoneLabels = { ideal: "Ideal zone", acceptable: "Acceptable zone", chase: "Chase zone", invalidated: "Invalidated zone" };

    // Position sizing rows.
    const sizingHTML = sz.valid ? `
      <div class="exrow"><span class="exk">Risk amount</span><span class="exv">$${sz.riskAmt.toFixed(2)} <small>(${sz.riskPct}% of $${sz.acct.toFixed(0)})</small></span></div>
      <div class="exrow"><span class="exk">Stop distance</span><span class="exv">$${fmtPrice(sz.stopDist)} <small>(${(r.slPct||0).toFixed(2)}%)</small></span></div>
      <div class="exrow"><span class="exk">Suggested size</span><span class="exv">${sz.qty>=1?sz.qty.toFixed(2):sz.qty.toPrecision(3)} units <small>≈ $${sz.notional.toFixed(2)} notional</small></span></div>
      <div class="exrow"><span class="exk">Leverage</span><span class="exv ${sz.levOk?"":"bad"}">${esc(sz.levNote)}</span></div>
      <div class="exrow"><span class="exk">Max loss if SL hits</span><span class="exv bad">-$${sz.maxLoss.toFixed(2)}</span></div>`
      : `<div class="exnote">Set <b>Account size</b> and <b>Risk %</b> in Settings to compute position sizing (kept in memory only).</div>`;

    const tl = tradeTimeline(r, plan);
    const timelineHTML = tl.map((s, i) => `
      <div class="exstep"><span class="exsn">${i+1}</span><div class="exsb"><b>${esc(s.t)}</b><span>${esc(s.d)}</span></div></div>`).join("");

    const invHTML = invalidationList(r).map(b => `<li>${esc(b)}</li>`).join("");

    return `<div class="expanel ${meta.cls}" data-testid="exec-panel-${esc(r.sym)}">
      <div class="exhead">
        <span class="exstatus ${meta.cls}" data-testid="exec-status-${esc(r.sym)}">${execIcon(meta.icon)}${meta.label}</span>
        <span class="exaction ${meta.cls}">${esc(meta.action)}</span>
      </div>

      <div class="exzone">
        <div class="exzonetop">
          <span>Current <b>$${fmtPrice(cur)}</b></span>
          <span class="${delta>=0?"up":"down"}">${deltaSign}${delta.toFixed(2)}% ${dirWord} entry</span>
          <span class="${fR>=0?"up":"down"}">${fR>=0?"+":""}${fR.toFixed(2)}R ${favorWord}</span>
        </div>
        <div class="exmeter"><span class="exband ideal"></span><span class="exband ok"></span><span class="exband chase"></span><i style="left:${zonePct}%"></i></div>
        <div class="exzonelbl">${zoneLabels[st.zone] || st.zone}</div>
      </div>

      <div class="exgrid">
        <div class="exsec">
          <div class="exsh">Execution plan</div>
          <div class="exrow"><span class="exk">Entry</span><span class="exv">${esc(plan.entryType)}</span></div>
          <div class="exrow"><span class="exk">SL</span><span class="exv s">$${fmtPrice(r.stop)} <small>(${(r.slPct||0).toFixed(2)}% risk)</small></span></div>
          <div class="exrow"><span class="exk">TP1 · 1R</span><span class="exv t">$${fmtPrice(plan.tp1)} <small>(+${plan.tp1Pct.toFixed(2)}%) · book ${plan.tp1Book}%</small></span></div>
          <div class="exrow"><span class="exk">TP2 · ${plan.finalR.toFixed(1)}R</span><span class="exv t">$${fmtPrice(plan.tp2)} <small>(+${plan.tp2Pct.toFixed(2)}%) · book ${plan.tp2Book}%</small></span></div>
          <div class="exrow"><span class="exk">Break-even</span><span class="exv">${esc(plan.beRule)}</span></div>
          <div class="exrow"><span class="exk">Trail</span><span class="exv">${esc(plan.trailNote)}</span></div>
        </div>
        <div class="exsec">
          <div class="exsh">Position sizing</div>
          ${sizingHTML}
        </div>
      </div>

      <div class="exsec">
        <div class="exsh">Trade management timeline</div>
        <div class="exsteps">${timelineHTML}</div>
      </div>

      <div class="exsec">
        <div class="exsh">Invalidation checklist — exit if any trigger</div>
        <ul class="exinv">${invHTML}</ul>
      </div>

      <div class="exdisc">Technical setup only — not financial advice. Follow risk size and SL. No order is placed; live execution stays locked.</div>
      <div class="exact">
        <button class="ghost" data-act="copyexec" data-sym="${esc(r.sym)}" data-testid="button-copy-exec-${esc(r.sym)}">⧉ Copy Execution Plan</button>
      </div>
    </div>`;
  }

  // Plain-text execution plan for clipboard / Telegram preview.
  function plainExecPlan(r) {
    const st = execStatus(r);
    const meta = EXEC_STATUS_META[st.code];
    const plan = execPlan(r);
    const sz = positionSizing(r);
    const cur = (Number.isFinite(r.mark) && r.mark > 0) ? r.mark : r.entry;
    const delta = r.entry ? (cur - r.entry) / r.entry * 100 : 0;
    const live = state.dataLive ? "LIVE DELTA PUBLIC DATA" : "DEMO / PREVIEW DATA";
    const lines = [
      `${r.dir.toUpperCase()} ${r.sym} — ${r.score8}/8 — EXECUTION PLAN`,
      `Status: ${meta.label}  |  Action: ${meta.action}`,
      `Current $${fmtPrice(cur)} (${delta>=0?"+":""}${delta.toFixed(2)}% vs entry) · ${favorR(r).toFixed(2)}R`,
      `Entry: ${plan.entryType}`,
      `SL $${fmtPrice(r.stop)} (${(r.slPct||0).toFixed(2)}% risk)`,
      `TP1 1R $${fmtPrice(plan.tp1)} (+${plan.tp1Pct.toFixed(2)}%) book ${plan.tp1Book}%`,
      `TP2 ${plan.finalR.toFixed(1)}R $${fmtPrice(plan.tp2)} (+${plan.tp2Pct.toFixed(2)}%) book ${plan.tp2Book}%`,
      `BE: ${plan.beRule}`,
    ];
    if (sz.valid) {
      lines.push(`Size ${sz.qty>=1?sz.qty.toFixed(2):sz.qty.toPrecision(3)} units ≈ $${sz.notional.toFixed(2)} notional · risk $${sz.riskAmt.toFixed(2)} (${sz.riskPct}%) · max loss -$${sz.maxLoss.toFixed(2)} · ${sz.levNote}`);
    }
    lines.push("Invalidation:");
    invalidationList(r).forEach(b => lines.push("  - " + b));
    lines.push(`Source: ${live} · scan-only · no order placed · not financial advice. Follow risk size and SL.`);
    return lines.join("\n");
  }
  function copyExecPlan(r, btn) {
    copyText(plainExecPlan(r), $("#copyReportFeed"), `${r.sym} execution plan`);
    if (btn) { const t = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(()=>{ btn.textContent = t; }, 1400); }
  }

  function planLabel() {
    if (state.mode === "scan") return "Scan-only · view plan";
    if (state.mode === "paper") return "Paper preview plan";
    if (state.mode === "testnet") return "Testnet order plan";
    if (state.mode === "live") return liveReady() ? "Live order plan" : "Live locked";
    return "View plan";
  }

  /* ---------- render ---------- */
  // Apply the active strategy profile's minimum-visible grade to a strict-8/8
  // list. Balanced/Strict show A+/A/B; Ultra Strict hides B (A and above).
  // No-trade-graded setups sink to the bottom (or hide under Ultra Strict).
  function applyProfileView(list) {
    const prof = activeProfile();
    const withGrade = list.map(r => ({ r, g: strategyMatch(r).grade }));
    const visible = withGrade.filter(x => gradeAtLeast(x.g, prof.minVisible) || (!prof.famUltra && x.g === "NO TRADE"));
    // Ultra Strict drops No-Trade entirely; others keep them at the bottom.
    const filtered = prof.famUltra ? visible.filter(x => x.g !== "NO TRADE") : visible;
    filtered.sort((a, b) => (GRADE_ORDER[b.g] - GRADE_ORDER[a.g]) || (qualityScore(b.r) - qualityScore(a.r)));
    return filtered.map(x => x.r);
  }
  function render() {
    const results = state.results;
    const kept = state.strict ? applyProfileView(results.filter(r => r.passed))
                              : results.filter(r => r.score8 >= 6).sort((a,b)=>b.score8-a.score8 || b.score4-a.score4);
    const passed = applyProfileView(results.filter(r => r.passed));

    // report — ALWAYS the exact raw 8/8 (or 6+/8) output, never filtered by the
    // strategy profile. The Strategy Match layer is an overlay; it never edits
    // the raw scanner report.
    const reportKept = state.strict
      ? results.filter(r => r.passed).sort((a,b)=>b.score4-a.score4)
      : kept;
    $("#report").innerHTML = results.length ? buildReport(results, reportKept) : '<span class="ln">// awaiting first scan</span>';

    // heat
    const allPassed = results.filter(r => r.passed);
    if (results.length) {
      const aboveCount = results.filter(r => r.above50).length;
      const biasPct = Math.round(aboveCount / results.length * 100);
      const avgFund = (results.reduce((s,r)=>s+r.fund,0)/results.length);
      const best = Math.max(...results.map(r=>r.score4));
      $("#hUniv").textContent = results.length;
      $("#hPass").textContent = allPassed.length;
      $("#hPassBar").style.width = Math.min(100, allPassed.length/results.length*100*3) + "%";
      const biasEl = $("#hBias");
      biasEl.textContent = biasPct + "%";
      biasEl.className = "hv " + (biasPct>=60?"long":biasPct<=40?"short":"warn");
      const fEl = $("#hFund"); fEl.textContent = avgFund.toFixed(4)+"%"; fEl.className = "hv " + (avgFund>0?"short":"long");
      $("#hBest").textContent = best; $("#hBestBar").style.width = best+"%";
      $("#hLast").textContent = new Date().toISOString().slice(11,16);
    }

    // mark seen keys for everything surfaced this scan (dedup memory) — use the
    // full passed set so dedup isn't affected by the visible profile filter.
    allPassed.forEach(r => { state.seenKeys.add(setupKey(r)); });

    renderRegime(results, allPassed);

    // cards (scan view) — show kept
    const cardsEl = $("#cards");
    $("#cardsLbl").textContent = state.strict ? "Setups — Clean (4-Family)" : "Setups — Watch preview";
    $("#cardsHint").textContent = state.strict ? "execution-eligible only" : "preview · 3+/4 families · never executes";
    if (!results.length) {
      cardsEl.innerHTML = `<div class="empty"><span class="big">No scan yet</span>Run a scan to surface clean setups that pass all four independent families.</div>`;
    } else if (!kept.length) {
      cardsEl.innerHTML = `<div class="empty"><span class="big">Zero qualifying setups</span>${state.strict?"No symbol passed all four families this scan. That is the protocol working — patience over forcing.":"No symbol reached 3/4 families this scan."}</div>`;
    } else {
      cardsEl.innerHTML = kept.map(cardHTML).join("");
    }

    // formation radar (near-forming 7/8 + forming 5-6/8) — overlay, never executes
    renderFormationRadar(results);

    // best 8/8 ranking + coin search panel (overlays, never execute)
    renderBestRank(results);
    renderCoinPanel();

    // passed view
    const passEl = $("#passedCards");
    if (!passed.length) {
      passEl.innerHTML = `<div class="empty"><span class="big">Nothing qualifies yet</span>Only setups scoring <b>8/8</b> appear here.</div>`;
    } else {
      passEl.innerHTML = passed.map(cardHTML).join("");
    }
    // nav count — reflect the full strict 8/8 count, not just visible grades
    const pc = $("#passCount");
    if (allPassed.length) { pc.style.display=""; pc.textContent = allPassed.length; } else pc.style.display="none";

    bindCardActions();
  }

  function bindCardActions() {
    $$("[data-act]").forEach(b => b.onclick = () => {
      const sym = b.getAttribute("data-sym");
      const r = state.results.find(x => x.sym === sym);
      if (!r) return;
      const act = b.getAttribute("data-act");
      if (act === "alert") return logAlert(r, true);
      if (act === "copy") return copySetup(r, b);
      if (act === "copyexec") return copyExecPlan(r, b);
      // plan
      showPlan(r);
    });
  }

  function showPlan(r) {
    const side = r.dir === "long" ? "BUY" : "SELL";
    const riskAmt = params.account_size * params.risk_pct / 100;
    const size = riskAmt / Math.max(1e-9, Math.abs(r.entry - r.stop));
    let tag = "[SCAN] read-only — no order";
    if (state.mode === "paper") tag = "[PAPER] simulated — no order sent";
    else if (state.mode === "testnet") tag = "[TESTNET] would route to Delta demo";
    else if (state.mode === "live") tag = liveReady() ? "[LIVE] would place market + reduce-only stop (TP manual)" : "[LIVE LOCKED] enable safeguards first";
    alert(
      `${r.sym} — ${side}  (${r.score8}/8)\n` +
      `${tag}\n\n` +
      `Entry  $${fmtPrice(r.entry)}\n` +
      `Stop   $${fmtPrice(r.stop)}  (${r.slPct.toFixed(2)}%)\n` +
      `Target $${fmtPrice(r.target)}  (${r.tpPct.toFixed(2)}%)\n` +
      `R:R    ${r.rr.toFixed(1)}\n` +
      `Size   ${size.toFixed(4)} units  ($${riskAmt.toFixed(2)} risk @ ${params.risk_pct}%)\n\n` +
      `Demo/preview values. Take-profit is intentionally not auto-placed (tick/lot sizes vary).`
    );
  }

  /* ---------- alerts ---------- */
  function logAlert(r, manual) {
    state.alerts.unshift({
      sym: r.sym, dir: r.dir, score: r.score8, entry: r.entry, rr: r.rr,
      t: new Date().toISOString().slice(11,19) + " UTC", manual: !!manual,
    });
    if (state.alerts.length > 60) state.alerts.length = 60;
    renderAlerts();
    if (window.__notifyOn && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(`8/8 ${r.dir.toUpperCase()} ${r.sym}`, { body: `Entry $${fmtPrice(r.entry)} · RR ${r.rr.toFixed(1)}` }); } catch(e){}
    }
  }
  function renderAlerts() {
    const el = $("#alertsRoot");
    const ac = $("#alertCount");
    if (!state.alerts.length) {
      el.innerHTML = `<div class="empty"><span class="big">No alerts</span>Each clean setup is logged here when a scan completes.</div>`;
      ac.style.display = "none"; return;
    }
    ac.style.display = ""; ac.textContent = state.alerts.length;
    el.innerHTML = state.alerts.map(a => `<div class="alertitem">
      <span class="ai ${esc(a.dir)}"></span>
      <span class="ab"><span class="at">${a.score}/8 ${esc(String(a.dir).toUpperCase())} ${esc(a.sym)}</span>
      <span class="ad">Entry $${fmtPrice(a.entry)} · RR ${a.rr.toFixed(1)} ${a.manual?"· manual log":"· auto"}</span></span>
      <span class="ax">${esc(a.t)}</span>
    </div>`).join("");
  }

  /* ---------- market regime strip ---------- */
  function renderRegime(results, passed) {
    if (!results || !results.length) return;
    const longP = passed.filter(r => r.dir === "long").length;
    const shortP = passed.filter(r => r.dir === "short").length;
    $("#rgLong").textContent = longP;
    $("#rgShort").textContent = shortP;
    const biasEl = $("#rgBias");
    let bias, biasCls;
    if (!passed.length) {
      // fall back to universe-wide above-50EMA proxy when nothing passed
      const above = results.filter(r => r.above50).length;
      const pct = Math.round(above / results.length * 100);
      bias = pct >= 60 ? "Long" : pct <= 40 ? "Short" : "Neutral";
      biasCls = pct >= 60 ? "long" : pct <= 40 ? "short" : "warn";
      $("#rgBiasSub").textContent = pct + "% above 50EMA";
    } else if (longP > shortP) { bias = "Long"; biasCls = "long"; $("#rgBiasSub").textContent = `${longP}L vs ${shortP}S`; }
    else if (shortP > longP) { bias = "Short"; biasCls = "short"; $("#rgBiasSub").textContent = `${longP}L vs ${shortP}S`; }
    else { bias = "Balanced"; biasCls = "warn"; $("#rgBiasSub").textContent = `${longP}L vs ${shortP}S`; }
    biasEl.textContent = bias; biasEl.className = "rgv " + biasCls;
    const avgFund = results.reduce((s,r)=>s+(r.fund||0),0)/results.length;
    const fEl = $("#rgFund"); fEl.textContent = avgFund.toFixed(4)+"%";
    fEl.className = "rgv " + (Math.abs(avgFund) < 0.005 ? "" : avgFund > 0 ? "short" : "long");
    // top quality among passed (or all if none passed)
    const pool = passed.length ? passed : results;
    let topQ = 0, topSym = "—";
    pool.forEach(r => { const q = qualityScore(r); if (q > topQ) { topQ = q; topSym = r.sym; } });
    $("#rgTop").textContent = topQ_label(topQ);
    $("#rgTopSub").textContent = topSym;
  }
  function topQ_label(q) { return q > 0 ? q + "/100" : "—"; }

  /* ---------- clipboard / export helpers ---------- */
  function plainSetup(r) {
    const q = qualityScore(r);
    const sm = strategyMatch(r);
    const cf = confirmatory(r);
    const bias = directionalBias(r);
    const val = validityFreshness(r);
    const live = state.dataLive ? "LIVE DELTA PUBLIC DATA" : "DEMO / PREVIEW DATA";
    return [
      `${r.dir.toUpperCase()} ${r.sym}  ${r.score8}/8  (Setup Quality ${q}/100 — checklist score)`,
      `Strategy Match: ${sm.grade} · ${sm.action} · ${sm.sizeNote}`,
      `Confirmatory: ${cf.status} · ${cf.meta.label} · ${cf.sizeNote} (combined ${cf.combinedMult.toFixed(2)}x)`,
      `Confirm checks: ${cf.topReasons.join(" · ")}`,
      `Directional bias (edge score, not a probability): ${bias.biasSide} ${bias.longChance}/${bias.shortChance} — ${bias.biasLabel}`,
      `Bias reasons: ${bias.biasReasons.join(" · ")}`,
      `Setup validity (rule-based freshness, not a guarantee): ${val.validityStatus} ${val.validityPct} — ${val.validityLabel}`,
      `Validity reasons: ${val.validityReasons.join(" · ")}`,
      `Why: ${sm.topReasons.join(" · ")}`,
      `Entry $${fmtPrice(r.entry)}  Stop $${fmtPrice(r.stop)} (${(r.slPct||0).toFixed(2)}%)  Target $${fmtPrice(r.target)} (${(r.tpPct||0).toFixed(2)}%)  RR ${(r.rr||0).toFixed(1)}`,
      `Fam ${r.famLong}/4  MTF ${r.mtfAgree}/${r.nTf}  RSI ${(r.rsi||0).toFixed(1)}  CUSUM ${r.cusumDir}  FR ${(r.fund||0).toFixed(4)}%`,
      `Rule-based checklist — not a probability or win rate. Source: ${live} · scan-only · no order placed · not financial advice.`,
    ].join("\n");
  }
  // Strip the report's span markup back to plain text for copying.
  function reportPlainText() {
    const el = $("#report");
    if (!el) return "";
    return (el.textContent || "").trim();
  }
  // Attempt clipboard write; fall back to a selectable text dialog when the
  // Clipboard API is unavailable (e.g. blocked inside an iframe).
  async function copyText(text, feedEl, label) {
    const show = (kind, msg) => { if (feedEl) { feedEl.className = "tgfeed show " + kind; feedEl.textContent = msg; } };
    if (!text || !text.trim()) { show("err", "Nothing to copy yet — run a scan first."); return; }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text);
        show("ok", `${label} copied to clipboard.`);
        return;
      }
      throw new Error("no clipboard");
    } catch (e) {
      // Fallback 1: legacy execCommand via a temporary textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.top = "-1000px";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand && document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) { show("ok", `${label} copied to clipboard.`); return; }
      } catch (_) { /* fall through */ }
      // Fallback 2: clipboard blocked (common in sandboxed iframes) — show
      // selectable text the user can copy manually.
      show("info", "Clipboard is blocked in this embedded view. Select the text below and copy manually:");
      if (feedEl) {
        const pre = document.createElement("textarea");
        pre.value = text; pre.readOnly = true;
        pre.style.cssText = "width:100%;margin-top:8px;height:120px;background:var(--ink);color:var(--txt);border:1px solid var(--line2);border-radius:6px;font-family:var(--mono);font-size:11px;padding:8px;";
        feedEl.appendChild(pre);
        pre.focus(); pre.select();
      }
    }
  }
  function copySetup(r, btn) {
    copyText(plainSetup(r), $("#copyReportFeed"), `${r.sym} setup`);
    if (btn) { const t = btn.textContent; btn.textContent = "✓ Copied"; setTimeout(()=>{ btn.textContent = t; }, 1400); }
  }
  function copyReport() {
    copyText(reportPlainText() || (state.lastReport || ""), $("#copyReportFeed"), "Report");
  }

  /* ---------- telegram alerts (manual send only) ---------- */
  // Build a concise plain-text report from current results as a fallback when
  // the backend did not supply its own report string (e.g. demo mode).
  function buildClientReport(results) {
    const live = state.dataLive ? "LIVE DELTA PUBLIC DATA" : "DEMO / PREVIEW DATA";
    const ts = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const passed = (results || []).filter(r => r.passed);
    const lines = [`Delta Scanner v6 · ${live}`, `Scanned ${ts}`,
      `${passed.length} clean of ${(results || []).length} evaluated`, ""];
    if (!passed.length) {
      lines.push("No symbol passed all four families this scan.");
    } else {
      passed.slice(0, 12).forEach(r => {
        lines.push(`${r.dir.toUpperCase()} ${r.sym}  entry ${fmtPrice(r.entry)}  RR ${r.rr.toFixed(1)}`);
      });
    }
    return lines.join("\n");
  }

  // The latest strict 8/8 setup from the most recent scan (or null).
  function latestSetup() {
    const passed = (state.results || []).filter(r => r.passed);
    if (!passed.length) return null;
    return passed.slice().sort((a, b) => (b.score4 || 0) - (a.score4 || 0))[0];
  }

  function tgFeedback(kind, msg) {
    const el = $("#tgFeed");
    if (!el) return;
    el.className = "tgfeed show " + kind;
    el.textContent = msg;
  }

  // Resolve the chosen chat id from selector or manual input.
  function tgChosenChatId() {
    const sel = $("#tgChatSelect");
    const manual = $("#tgChatManual");
    if (sel && sel.value === "__manual__") return (manual.value || "").trim();
    if (sel && sel.value) return sel.value;
    // If a manual value was typed without switching the selector, honour it.
    return (manual && manual.value || "").trim();
  }

  function tgSetButtonsDisabled(disabled) {
    ["#tgSendSetup", "#tgSendReport", "#tgLoadChats"].forEach(id => {
      const b = $(id); if (b) b.disabled = disabled;
    });
  }

  // Reflect connector availability in the status card.
  function renderTgStatus() {
    const dot = $("#tgDot");
    const st = $("#tgStatus");
    if (!dot || !st) return;
    if (state.tgConnector === null) {
      dot.className = "tgdot warn";
      st.innerHTML = "Checking Telegram connector…";
    } else if (state.tgConnector === true) {
      dot.className = "tgdot ok";
      const n = state.tgChats.length;
      st.innerHTML = `<b>Connected.</b> ${n ? n + " chat" + (n===1?"":"s") + " loaded." : "Load chats or enter a chat ID to send."}`;
    } else {
      dot.className = "tgdot bad";
      st.innerHTML = "<b>Telegram connector unavailable.</b> Restart the backend with external-tools credentials — the Telegram connector is required to send alerts.";
    }
  }

  // Populate the chat <select> with loaded chats.
  function renderTgChats() {
    const sel = $("#tgChatSelect");
    if (!sel) return;
    const prev = sel.value;
    const opts = [`<option value="">— Load chats or enter an ID below —</option>`];
    state.tgChats.forEach(c => {
      const label = `${c.title}${c.type && c.type !== "chat" ? " · " + c.type : ""} (${c.id})`;
      opts.push(`<option value="${esc(c.id)}">${esc(label)}</option>`);
    });
    opts.push(`<option value="__manual__">Enter chat ID manually…</option>`);
    sel.innerHTML = opts.join("");
    // Restore prior selection if still present.
    if (prev && Array.from(sel.options).some(o => o.value === prev)) sel.value = prev;
    syncManualInput();
  }

  function syncManualInput() {
    const sel = $("#tgChatSelect");
    const manual = $("#tgChatManual");
    if (!sel || !manual) return;
    manual.style.display = sel.value === "__manual__" ? "" : "none";
  }

  async function tgLoadChats() {
    if (state.tgBusy) return;
    state.tgBusy = true; tgSetButtonsDisabled(true);
    tgFeedback("busy", "Loading chats from Telegram…");
    try {
      const res = await fetch(API_BASE + "/api/telegram/chats?limit=50", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      if (data && data.connector === false) {
        state.tgConnector = false; state.tgChats = [];
        renderTgStatus(); renderTgChats();
        tgFeedback("err", data.hint || "Telegram connector unavailable. Restart the backend with external-tools credentials.");
        return;
      }
      state.tgConnector = true;
      state.tgChats = Array.isArray(data.chats) ? data.chats : [];
      renderTgStatus(); renderTgChats();
      if (!data.ok) {
        tgFeedback("info", data.hint || data.error || "No chats found. Send a message to your bot first, then retry — or enter a chat ID manually.");
      } else if (!state.tgChats.length) {
        tgFeedback("info", "No chats found yet. Send a message to your bot (or add it to a group), then retry — or enter a chat ID manually.");
      } else {
        tgFeedback("ok", `Loaded ${state.tgChats.length} chat${state.tgChats.length===1?"":"s"}. Pick one and send.`);
      }
    } catch (e) {
      state.tgConnector = false; renderTgStatus();
      tgFeedback("err", "Could not reach the backend. Is the server running with external-tools credentials?");
    } finally {
      state.tgBusy = false; tgSetButtonsDisabled(false);
    }
  }

  // Compact strategy block for the Telegram payload (rule-based; no win-rate/confidence%).
  function strategyPayload(r) {
    const sm = strategyMatch(r);
    return {
      grade: sm.grade,
      action: sm.action,
      sizeNote: sm.sizeNote,
      sizeMult: sm.sizeMult,
      profile: activeProfile().label,
      topReasons: sm.topReasons,
    };
  }

  // Compact confirmatory block for the Telegram payload (rule-based status +
  // size adjustment; never a probability, win-rate, or forecast).
  function confirmPayload(r) {
    const cf = confirmatory(r);
    return {
      statusLabel: cf.status + " · " + cf.meta.label,
      action: cf.meta.action,
      sizeNote: cf.sizeNote,
      combinedMult: cf.combinedMult,
      topReasons: cf.topReasons,
    };
  }

  async function tgSend(kind) {
    if (state.tgBusy) return;
    const chatId = tgChosenChatId();
    if (!chatId) { tgFeedback("err", "Choose a chat or enter a chat ID first."); return; }

    const payload = { chatId, silent: !!($("#tgSilent") && $("#tgSilent").checked) };
    if (kind === "setup") {
      const s = latestSetup();
      if (!s) { tgFeedback("err", "No clean setup yet. Run a scan that surfaces a clean (4-family) setup first."); return; }
      payload.setup = {
        sym: s.sym, dir: s.dir, score8: s.score8,
        entry: s.entry, stop: s.stop, target: s.target, rr: s.rr,
        exec: execSummary(s),
        strategy: strategyPayload(s),
        confirm: confirmPayload(s),
      };
    } else {
      const report = state.lastReport || buildClientReport(state.results);
      if (!report.trim()) { tgFeedback("err", "No scan report yet. Run a scan first."); return; }
      payload.report = report;
    }

    state.tgBusy = true; tgSetButtonsDisabled(true);
    tgFeedback("busy", kind === "setup" ? "Sending latest 8/8 setup…" : "Sending scanner report…");
    try {
      const res = await fetch(API_BASE + "/api/telegram/alert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok && data.sent) {
        state.tgConnector = true; renderTgStatus();
        tgFeedback("ok", `Sent to ${esc(chatId)} · ${data.chars} chars${payload.silent ? " · silent" : ""}.`);
      } else if (data && data.connector === false) {
        state.tgConnector = false; renderTgStatus();
        tgFeedback("err", data.hint || "Telegram connector unavailable. Restart the backend with external-tools credentials.");
      } else {
        tgFeedback("err", (data && (data.error || data.hint)) || ("Send failed (HTTP " + res.status + ")."));
      }
    } catch (e) {
      tgFeedback("err", "Could not reach the backend to send. Is the server running?");
    } finally {
      state.tgBusy = false; tgSetButtonsDisabled(false);
    }
  }

  // Lightweight connector probe on first opening the Alerts view (no message sent).
  let tgProbed = false;
  async function tgProbe() {
    if (tgProbed) return; tgProbed = true;
    try {
      const res = await fetch(API_BASE + "/api/telegram/chats?limit=1", { method: "GET" });
      const data = await res.json().catch(() => ({}));
      state.tgConnector = data && data.connector === false ? false : true;
      if (Array.isArray(data.chats) && data.chats.length) { state.tgChats = data.chats; renderTgChats(); }
    } catch (e) {
      state.tgConnector = false;
    }
    renderTgStatus();
  }

  /* ---------- optional in-app Telegram auto-send (default OFF) ----------
   * Only ever active while Auto Watch is running AND this toggle is ON in the
   * current session. Sends each NEW strict 8/8 setup exactly once (dedup by
   * setup key). Requires a chat id to be selected/entered first.
   */
  function tgAutoFeedback(kind, msg) {
    const el = $("#tgAutoFeed");
    if (!el) return;
    el.className = "tgfeed show " + kind;
    el.textContent = msg;
  }
  function renderTgAutoToggle() {
    const sw = $("#tgAutoSw");
    if (!sw) return;
    sw.classList.toggle("armed", state.tgAutoSend);
    sw.setAttribute("aria-checked", String(state.tgAutoSend));
  }
  function tgToggleAuto() {
    if (!state.tgAutoSend) {
      // turning ON: require connector + chat id
      if (state.tgConnector === false) {
        tgAutoFeedback("err", "Telegram connector unavailable. Restart the backend with external-tools credentials.");
        return;
      }
      const chatId = tgChosenChatId();
      if (!chatId) {
        tgAutoFeedback("err", "Choose a chat or enter a chat ID first, then enable auto-send.");
        return;
      }
      state.tgAutoSend = true;
      renderTgAutoToggle();
      tgAutoFeedback("ok", `Auto-send ARMED for ${esc(chatId)}. NEW clean setups found during Auto Watch will be sent once each. Session only.`);
    } else {
      state.tgAutoSend = false;
      renderTgAutoToggle();
      tgAutoFeedback("info", "Auto-send disabled. No setups will be sent automatically.");
    }
  }
  // Send one setup automatically (used only by Auto Watch when armed). Returns
  // true if sent. Never throws to the caller.
  async function tgAutoSendSetup(r) {
    const chatId = tgChosenChatId();
    if (!chatId) return false;
    const key = setupKey(r);
    if (state.sentKeys.has(key)) return false; // never duplicate in a session
    const payload = {
      chatId,
      silent: !!($("#tgSilent") && $("#tgSilent").checked),
      setup: { sym: r.sym, dir: r.dir, score8: r.score8, entry: r.entry, stop: r.stop, target: r.target, rr: r.rr, exec: execSummary(r), strategy: strategyPayload(r), confirm: confirmPayload(r) },
    };
    try {
      const res = await fetch(API_BASE + "/api/telegram/alert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok && data.sent) {
        state.sentKeys.add(key);
        state.tgConnector = true;
        return true;
      }
      if (data && data.connector === false) {
        state.tgConnector = false;
        state.tgAutoSend = false; // disarm on connector loss
        renderTgStatus(); renderTgAutoToggle();
        tgAutoFeedback("err", "Telegram connector became unavailable — auto-send disarmed.");
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  // Process a completed scan's strict 8/8 setups for auto-send (NEW only).
  // Confirmatory-layer gate (deterministic, no probability/win-rate):
  //   • NEVER auto-send RED or Strategy "NO TRADE".
  //   • Auto-send ONLY GREEN or YELLOW that also clear Strategy A/A+ (≥ profile minAuto).
  //   • ORANGE is excluded from auto-send entirely — it is a manual-only path
  //     (ORANGE + Balanced profile may be sent by the user with the manual
  //     “Send latest setup” button, never automatically).
  async function tgAutoProcess(passed) {
    if (!state.tgAutoSend || !state.aw.on) return;
    const minAuto = activeProfile().minAuto;
    const fresh = passed.filter(r => !state.sentKeys.has(setupKey(r)))
      .filter(r => {
        const grade = strategyMatch(r).grade;
        if (grade === "NO TRADE") return false;          // hard exclude
        if (!gradeAtLeast(grade, minAuto)) return false; // profile grade floor (A / A+)
        const cf = confirmatory(r).status;
        if (cf === "RED" || cf === "ORANGE") return false; // RED never, ORANGE manual-only
        return cf === "GREEN" || cf === "YELLOW";          // only GREEN / YELLOW auto-send
      })
      .sort(strategyCompare);
    let sent = 0;
    for (const r of fresh) {
      const ok = await tgAutoSendSetup(r);
      if (ok) sent++;
      if (!state.tgAutoSend) break; // disarmed mid-loop
    }
    if (sent > 0) {
      tgAutoFeedback("ok", `Auto-sent ${sent} NEW setup${sent===1?"":"s"} ≥ grade ${minAuto} with GREEN/YELLOW confirmatory this scan.`);
      render(); // refresh “sent” badges
    }
  }

  function bindTelegram() {
    const load = $("#tgLoadChats"); if (load) load.onclick = tgLoadChats;
    const sel = $("#tgChatSelect"); if (sel) sel.onchange = syncManualInput;
    const sendS = $("#tgSendSetup"); if (sendS) sendS.onclick = () => tgSend("setup");
    const sendR = $("#tgSendReport"); if (sendR) sendR.onclick = () => tgSend("report");
    const autoSw = $("#tgAutoSw"); if (autoSw) autoSw.onclick = tgToggleAuto;
    renderTgStatus();
    renderTgAutoToggle();
  }

  /* ---------- scan flow ---------- */
  let scanInFlight = false;
  async function runScan() {
    if (scanInFlight) return;          // guard against overlapping Auto Watch ticks
    scanInFlight = true;
    if (state.aw.on) { state.aw.scanning = true; state.aw.status = "Scanning"; renderAutoWatch(); }
    const btn = $("#scanBtn");
    btn.disabled = true; btn.textContent = "Scanning…";
    const cardsEl = $("#cards");
    cardsEl.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
    const bar = $("#progBar");
    bar.style.width = "0%";
    const liveTarget = params.max_symbols >= 1000 ? "full Delta futures universe" : `${params.max_symbols} symbols`;
    const total = 12; // fast live progress animation; backend returns the real universe count
    for (let i=1;i<=total;i++){
      const pct = i/total*100;
      bar.style.width = pct + "%";
      $("#scanState").innerHTML = `Evaluating <b>${liveTarget}</b> · ${params.concurrency} workers · entry ${esc(params.entry_tf)} · MTF ${esc(params.mtf_timeframes)}`;
      await sleep(8);
    }
    const scanRes = await fetchScan();
    const results = scanRes.results;
    state.results = results;
    state.dataLive = scanRes.live;
    state.marketRegime = scanRes.marketRegime || null;
    state.lastScanAt = Date.now(); // for setup-validity freshness/age (real, not faked)
    updateBiasHistory(results); // session scanner-memory proxy (not PnL)
    state.backendNote = scanRes.note || "";
    state.lastReport = scanRes.report || buildClientReport(results);
    updateDataBanner();
    const passed = results.filter(r => r.passed);
    // Duplicate-alert protection: only log a session alert the FIRST time a
    // given setup key is surfaced. Seen keys are recorded in render().
    const newPassed = passed.filter(r => !state.seenKeys.has(setupKey(r)));
    newPassed.forEach(r => logAlert(r, false));
    const srcLabel = scanRes.live ? "LIVE DELTA" : "DEMO DATA";
    const newTag = newPassed.length ? ` · <b>${newPassed.length}</b> new` : "";
    $("#scanState").innerHTML = `Scan complete · <b>${passed.length}</b> clean of <b>${results.length}</b>${newTag} · ${srcLabel} · ${new Date().toISOString().slice(11,16)} UTC`;
    setTimeout(()=>{ bar.style.width="0%"; }, 600);
    btn.disabled = false; btn.textContent = "▶ Run scan";
    render(); // marks seen keys and refreshes badges/regime
    // Optional in-app Telegram auto-send (NEW strict 8/8 only) — after render so
    // dedup memory reflects what was just surfaced.
    await tgAutoProcess(passed);
    // Auto Watch bookkeeping
    state.aw.scanning = false;
    state.aw.count += 1;
    state.aw.lastScanAt = new Date().toISOString().slice(11, 16) + " UTC";
    if (state.aw.on) {
      state.aw.remaining = state.aw.intervalSec;
      state.aw.status = "Waiting";
    }
    renderAutoWatch();
    scanInFlight = false;
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ---------- Auto Watch (in-app repeated scans; no background scheduler) ----
   * Repeats scans on a 1s countdown ticker while the app is open. There is NO
   * background scheduler / service-worker timer / cron — closing or freezing
   * the page stops it. Visibility changes are respected (paused when hidden).
   */
  function fmtCountdown(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }
  function renderAutoWatch() {
    const aw = state.aw;
    const panel = $("#awPanel");
    if (panel) panel.classList.toggle("on", aw.on);
    const toggle = $("#awToggle");
    if (toggle) {
      toggle.textContent = aw.on ? "■ Stop Auto Watch" : "▶ Start Auto Watch";
      toggle.classList.toggle("go", !aw.on);
    }
    const cd = $("#awCountdown");
    if (cd) cd.textContent = aw.on ? fmtCountdown(aw.remaining) : "—";
    const last = $("#awLast"); if (last) last.textContent = aw.lastScanAt || "—";
    const cnt = $("#awCount"); if (cnt) cnt.textContent = aw.count;
    const sm = $("#awStatusMetric"); if (sm) sm.textContent = aw.status;
    const st = $("#awStatusTxt"); if (st) st.textContent = aw.on ? aw.status : "Idle";
    // disable interval changes while running (must stop first)
    $$("#awIntSeg button").forEach(b => { b.disabled = aw.on; });
  }
  function awTick() {
    const aw = state.aw;
    if (!aw.on) return;
    if (document.hidden) return;       // pause countdown while app is hidden
    if (aw.scanning) return;           // don't tick down during an active scan
    aw.remaining -= 1;
    if (aw.remaining <= 0) {
      aw.remaining = aw.intervalSec;
      runScan();                       // fire next scan (guarded against overlap)
    }
    renderAutoWatch();
  }
  function startAutoWatch() {
    const aw = state.aw;
    if (aw.on) return;
    aw.on = true;
    aw.remaining = aw.intervalSec;
    aw.status = "Scanning";
    if (aw.tickTimer) clearInterval(aw.tickTimer);
    aw.tickTimer = setInterval(awTick, 1000);
    renderAutoWatch();
    runScan();                         // immediate first scan on start
  }
  function stopAutoWatch() {
    const aw = state.aw;
    aw.on = false;
    aw.status = "Idle";
    aw.remaining = 0;
    if (aw.tickTimer) { clearInterval(aw.tickTimer); aw.tickTimer = null; }
    renderAutoWatch();
  }
  function toggleAutoWatch() { state.aw.on ? stopAutoWatch() : startAutoWatch(); }
  function bindAutoWatch() {
    const toggle = $("#awToggle");
    if (toggle) toggle.onclick = toggleAutoWatch;
    $$("#awIntSeg button").forEach(b => b.onclick = () => {
      if (state.aw.on) return;         // locked while running
      $$("#awIntSeg button").forEach(x => x.classList.toggle("on", x === b));
      state.aw.intervalSec = parseInt(b.getAttribute("data-int"), 10) || 300;
      renderAutoWatch();
    });
    // If the tab is hidden for a while, the countdown pauses; nothing else fires.
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.aw.on) renderAutoWatch(); });
    renderAutoWatch();
  }

  /* ---------- parameters UI ---------- */
  /* ---------- Strategy Match profile + explainer cards ---------- */
  function renderStrategy() {
    const root = $("#strategyRoot");
    if (!root) return;
    const prof = activeProfile();
    const profKeys = [
      { k: "balanced", t: "Balanced",         sub: "A+ / A / B" },
      { k: "strict",   t: "Strict Assistant", sub: "default · A+ / A focus" },
      { k: "ultra",    t: "Ultra Strict",     sub: "A+ / A only · Fam 4/4" },
    ];
    const segs = profKeys.map(p =>
      `<button class="segbtn ${state.strategyProfile===p.k?"on":""}" data-prof="${p.k}" data-testid="profile-${p.k}">${esc(p.t)}<span class="sgt">${esc(p.sub)}</span></button>`
    ).join("");

    // Profile control card
    const profileCard = `<div class="scard">
      <div class="sch">Strategy profile</div>
      <div class="scsub">Controls which grades surface, sort order, badges, and the minimum grade an Auto Watch setup must reach before Telegram auto-send fires. Rule-based only — no probability or win-rate.</div>
      <div class="segmented" role="group" aria-label="Strategy profile">${segs}</div>
      <div class="profnote"><b>${esc(prof.label)}.</b> ${esc(prof.note)} Minimum auto-send grade: <span class="ag">${esc(prof.minAuto)}</span> or above.</div>
    </div>`;

    // My Logic explainer card
    const logicCard = `<div class="scard">
      <div class="sch">My logic — how I read a setup</div>
      <div class="scsub">The discipline the Strategy Match grade is built to mirror.</div>
      <ul class="logiclist">
        <li><b>No blind entry.</b> Before anything, check live price, spread, that the scan is still valid, the BTC/regime backdrop, and my risk per trade.</li>
        <li><b>Partial entry first.</b> Enter with partial size on an A+/A in the ideal zone — never full size, never chasing.</li>
        <li><b>TP1 at 1R, then de-risk.</b> Take first target at 1R and move the stop to break-even so the trade can't turn into a loss.</li>
        <li><b>Let the rest run to the final TP.</b> Trail the remainder toward the structural target.</li>
        <li><b>Wait or stand aside</b> when the zone is acceptable-not-ideal, funding/regime is mixed, or the gate is below 8 — patience beats forcing.</li>
      </ul>
      <div class="scdisc">This is a technical setup read only — not financial advice. You decide every entry; the app never places real orders.</div>
    </div>`;

    // Confirmatory Signal Layer explainer card
    const confirmCard = `<div class="scard">
      <div class="sch">Confirmatory Signal Layer</div>
      <div class="scsub">A rule-based layer that runs <b>after</b> the 8/8 gate and Strategy Match. It only <b>confirms</b>, <b>reduces size</b>, or <b>blocks</b> — it is <b>not a prediction engine</b> and never produces a probability or win rate.</div>
      <ul class="logiclist">
        <li><b style="color:var(--long)">GREEN — Entry allowed.</b> Clean (4-family) + Strategy A/A+ + BTC regime not against + funding not against/crowded + volume confirms or neutral + price near entry/retest + liquidity acceptable.</li>
        <li><b style="color:var(--amber)">YELLOW — Wait for retest.</b> Good setup but needs a retest, or a confirming piece is neutral or unavailable. Missing data alone never blocks.</li>
        <li><b style="color:#ff8a3d">ORANGE — Reduce size.</b> Valid but mixed context (e.g. BTC against, VWAP against, weak volume, thin liquidity, wide stop). Manual send only.</li>
        <li><b style="color:var(--short)">RED — No trade.</b> Strategy No Trade, setup invalidated, CUSUM/MTF mismatch, BTC strongly against, funding against/crowded, or severe chase. Never auto-sent.</li>
      </ul>
      <div class="scsub" style="margin-top:11px">Crypto-native fundamentals only — <b>liquidity</b> (turnover proxy), <b>funding</b> pressure, <b>open interest</b> presence, <b>BTC dominance / market regime</b>, and <b>event/news risk</b> (manual check required — never auto-scraped). No fake equity-style fundamentals, no fabricated OI direction, no scraped news.</div>
      <div class="alertrule"><b>Size:</b> a confirmatory multiplier (1.0 / 0.75 / 0.5 / 0.25 / 0) is applied conceptually <b>after</b> the Strategy Match multiplier. <b>Auto-send:</b> only GREEN or YELLOW with Strategy A/A+ are sent automatically; RED and No-Trade are never sent; ORANGE is manual only.</div>
      <div class="scdisc">Deterministic checklist over live Delta India public data — not a forecast, probability, or financial advice. The app never places real orders.</div>
    </div>`;

    // Solid-only keep/drop card
    const keepDropCard = `<div class="scard">
      <div class="sch">Solid-only strategy rules</div>
      <div class="scsub">What this strategy keeps, and what it drops. Grades stay A+ / A / B / No Trade as a rule-based checklist — never a confidence % or win rate.</div>
      <div class="kdgrid">
        <div class="kdcol keep">
          <div class="kdh">Keeps — proven, non-circular</div>
          <ul class="kdlist">
            <li><b>Funding &gt; 0.3% block</b> — real crowding, proven signal</li>
            <li><b>RSI exhaustion block</b> — established, non-circular</li>
            <li><b>EMA cross for trend</b> — simple and reliable</li>
            <li><b>MTF cascade</b> (4h/1h/15m/5m target) — strongest alignment filter</li>
            <li><b>Judas / Asian range</b> — liquidity grab is sound</li>
            <li><b>Delta India API only</b> — the only reliable source in India</li>
          </ul>
        </div>
        <div class="kdcol drop">
          <div class="kdh">Drops — unproven or circular</div>
          <ul class="kdlist">
            <li><b>Confidence % formula</b> — circular, just relabels 4/4</li>
            <li><b>AI ensemble score</b> — no backtest, hand-picked weights</li>
            <li><b>Win-rate labels</b> — no real sample behind them</li>
            <li><b>10+ competing signal layers</b> — they contradict each other</li>
          </ul>
        </div>
      </div>
      <div class="alertrule"><b>Alert rule:</b> Fire an alert when the MTF cascade is 4/4 + Judas confirmed + funding clean + RSI not exhausted — and log every outcome.</div>
      <div class="scsub" style="margin-top:11px;margin-bottom:0">MTF cascade target is 4h/1h/15m/5m; the current scanner uses the available configured timeframes (default 4h/1h/15m). A 3/3 alignment is kept and labelled accordingly rather than inflated.</div>
    </div>`;

    root.innerHTML = profileCard + logicCard + confirmCard + keepDropCard;

    $$("#strategyRoot .segbtn").forEach(b => b.onclick = () => {
      state.strategyProfile = b.getAttribute("data-prof");
      renderStrategy();
      render();
    });
  }

  function renderSettings() {
    const root = $("#settingsRoot");
    root.innerHTML = PARAM_GROUPS.map(g => `
      <div class="cfg">
        <div class="cfghead"><span class="gico">⌇</span>${g.title}</div>
        <div class="grid">
          ${g.fields.map(f => fieldHTML(f)).join("")}
        </div>
      </div>`).join("") + `
      <div class="cfgactions">
        <button class="ghost" id="resetParams">Reset to defaults</button>
      </div>`;
    // bind
    PARAM_GROUPS.forEach(g => g.fields.forEach(f => {
      const el = document.getElementById("p_"+f.id);
      if (!el) return;
      el.onchange = () => {
        params[f.id] = f.type === "num" ? (el.value===""?0:parseFloat(el.value)) : el.value;
        render();
      };
    }));
    $("#resetParams").onclick = () => {
      PARAM_GROUPS.forEach(g => g.fields.forEach(f => { params[f.id]=f.val; const el=document.getElementById("p_"+f.id); if(el) el.value=f.val; }));
      render();
    };
  }
  function fieldHTML(f) {
    let input;
    if (f.type === "sel") {
      input = `<select id="p_${f.id}">${f.opts.map(o=>`<option value="${o[0]}" ${o[0]===f.val?"selected":""}>${o[1]}</option>`).join("")}</select>`;
    } else if (f.type === "txt") {
      input = `<input id="p_${f.id}" type="text" value="${f.val}" spellcheck="false">`;
    } else {
      input = `<input id="p_${f.id}" type="number" value="${f.val}" step="${f.step||1}">`;
    }
    return `<div class="fld"><label>${f.label}</label>${input}${f.hint?`<span class="hint">${f.hint}</span>`:""}</div>`;
  }

  /* ---------- execution mode UI ---------- */
  const MODES = [
    { key:"scan",   t:"Scan Only",     tag:"Default", d:"Evaluate the universe. No auth, no orders ever. The only mode that needs no credentials." },
    { key:"paper",  t:"Paper Preview", tag:"Safe",    d:"Builds full order plans (side, size, SL/TP, RR) from your account size. Nothing is sent." },
    { key:"testnet",t:"Testnet",       tag:"Demo",    d:"Routes plans to Delta demo (cdn-ind.testnet). Requires demo API key in the backend env." },
    { key:"live",   t:"Live",          tag:"Locked",  d:"Real money. Locked until an API key + both risk toggles are configured in the backend." },
  ];
  function liveReady(){ return state.liveApiKeyConfigured && state.liveRiskAck; }

  function renderExec() {
    const root = $("#execRoot");
    const cards = MODES.map(m => {
      const locked = m.key === "live" && !liveReady();
      const on = state.mode === m.key;
      const tagColor = m.key==="live"?(locked?"var(--shortdim)":"var(--longdim)"):m.key==="testnet"?"var(--purpledim)":m.key==="paper"?"var(--amberdim)":"var(--tealdim2)";
      const tagText = m.key==="live"?(locked?"Locked":"Armed"):m.tag;
      const tagFg = m.key==="live"?(locked?"var(--short)":"var(--long)"):m.key==="testnet"?"var(--purple)":m.key==="paper"?"var(--amber)":"var(--teal)";
      const lock = m.key==="live" ? `<span class="lockico">${locked?lockSvg():unlockSvg()}</span>` : "";
      return `<div class="execcard ${m.key} ${on?"on":""} ${locked?"locked":""}" data-mode="${m.key}">
        <div class="ec-t">${m.t}${lock}</div>
        <div class="ec-d">${m.d}</div>
        <div style="margin-top:9px"><span class="ec-tag" style="background:${tagColor};color:${tagFg}">${tagText}</span></div>
      </div>`;
    }).join("");

    const guard = `
      <div class="guard">
        <div class="gt">Live trading safeguards (front-end demo — no secrets stored)</div>
        <div class="toggle">
          <span class="tl"><b>API key configured</b><span class="ts">Simulates a backend-held Delta key. Real key/secret never touch the browser.</span></span>
          <div class="sw ${state.liveApiKeyConfigured?"on":""}" id="swKey" role="switch" aria-checked="${state.liveApiKeyConfigured}"></div>
        </div>
        <div class="toggle">
          <span class="tl"><b>I understand live risk</b><span class="ts">Mirrors I_UNDERSTAND_LIVE_RISK=true. Required before Live unlocks.</span></span>
          <div class="sw ${state.liveRiskAck?"on":""}" id="swRisk" role="switch" aria-checked="${state.liveRiskAck}"></div>
        </div>
      </div>`;

    let banner;
    if (state.mode === "live" && liveReady()) {
      banner = `<div class="banner warn"><b>LIVE ARMED (demo).</b> In a real deployment this would place a market entry + reduce-only stop per 8/8 setup. TP is left manual by design. Start with tiny size; verify symbol, contract size, leverage and margin mode. Nothing here is financial advice.</div>`;
    } else if (state.mode === "live") {
      banner = `<div class="banner info">Live is <b>locked</b>. Enable both safeguards above to arm it. Even armed, this static preview never sends real orders — execution requires the Python backend with your own API credentials.</div>`;
    } else if (state.mode === "testnet") {
      banner = `<div class="banner info"><b>Testnet selected.</b> Order plans would route to Delta demo via the backend. Safe — no real funds.</div>`;
    } else if (state.mode === "paper") {
      banner = `<div class="banner ok"><b>Paper preview.</b> Full order plans are built from your account size and risk %, but nothing is sent.</div>`;
    } else {
      banner = `<div class="banner ok"><b>Scan only.</b> Pure evaluation — the safest mode. No credentials, no orders.</div>`;
    }

    root.innerHTML = `<div class="execgrid">${cards}</div>${guard}${banner}`;

    $$("#execRoot .execcard").forEach(c => c.onclick = () => {
      const m = c.getAttribute("data-mode");
      if (m === "live" && !liveReady()) { renderExec(); return; }
      state.mode = m;
      updateHeadMode();
      renderExec();
      render();
    });
    $("#swKey").onclick = () => { state.liveApiKeyConfigured = !state.liveApiKeyConfigured; if(!liveReady()&&state.mode==="live")state.mode="scan"; updateHeadMode(); renderExec(); render(); };
    $("#swRisk").onclick = () => { state.liveRiskAck = !state.liveRiskAck; if(!liveReady()&&state.mode==="live")state.mode="scan"; updateHeadMode(); renderExec(); render(); };
  }
  function lockSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`; }
  function unlockSvg(){ return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`; }

  function updateHeadMode() {
    const el = $("#headMode");
    const map = { scan:["scan","Scan Only"], paper:["paper","Paper Preview"], testnet:["testnet","Testnet"], live:["live","Live Armed"] };
    const [cls, txt] = map[state.mode];
    el.className = "modepill " + cls;
    el.innerHTML = `<i></i>${txt}`;
  }

  /* ---------- nav ---------- */
  function bindNav() {
    $$(".navbtn").forEach(b => b.onclick = () => {
      const v = b.getAttribute("data-view");
      $$(".navbtn").forEach(x => x.classList.toggle("on", x===b));
      $$(".view").forEach(s => s.classList.toggle("active", s.id === "view-"+v));
      window.scrollTo({top:0,behavior:"smooth"});
      if (v === "alerts") tgProbe();
      if (v === "tools") refreshOutcomeLab();
    });
  }

  /* ---------- controls ---------- */
  async function requestNotify(btn) {
    if (!("Notification" in window)) {
      if (btn) btn.textContent = "🔔 Notifications n/a";
      return;
    }
    const p = await Notification.requestPermission();
    window.__notifyOn = p === "granted";
    const label = window.__notifyOn ? "🔔 Notifications on" : "🔔 Notifications blocked";
    [$("#notifyBtn"), $("#notifyBtnScan")].forEach(b => { if (b) b.textContent = label; });
  }

  function bindControls() {
    const scanBtn = $("#scanBtn");
    if (scanBtn) scanBtn.onclick = runScan;
    $$("#strictSeg button").forEach(b => b.onclick = () => {
      $$("#strictSeg button").forEach(x => x.classList.toggle("on", x===b));
      state.strict = b.getAttribute("data-strict") === "1";
      render();
    });
    const copyBtn = $("#copyReport");
    if (copyBtn) copyBtn.onclick = copyReport;
    const nBtn = $("#notifyBtn");
    if (nBtn) nBtn.onclick = () => requestNotify(nBtn);
    const nBtnScan = $("#notifyBtnScan");
    if (nBtnScan) nBtnScan.onclick = () => requestNotify(nBtnScan);
    const clearBtn = $("#clearAlerts");
    if (clearBtn) clearBtn.onclick = () => { state.alerts = []; renderAlerts(); };

    // ---- Coin Search Analyzer ----
    const coinIn = $("#coinSearch");
    if (coinIn) coinIn.oninput = renderCoinPanel;
    const coinClr = $("#coinSearchClear");
    if (coinClr) coinClr.onclick = () => { if (coinIn) coinIn.value = ""; renderCoinPanel(); if (coinIn) coinIn.focus(); };

    // ---- Trade Calculator ----
    ["#calcAcct","#calcRisk","#calcSide","#calcEntry","#calcSL","#calcTP","#calcLev"].forEach(sel => {
      const el = $(sel);
      if (el) { el.oninput = calcCompute; el.onchange = calcCompute; }
    });
    $$("#view-tools [data-risk]").forEach(b => b.onclick = () => {
      const ri = $("#calcRisk"); if (ri) ri.value = b.getAttribute("data-risk");
      calcCompute();
    });

    // ---- Position Hold/Exit Checker ----
    const posCheck = $("#posCheck");
    if (posCheck) posCheck.onclick = renderPosition;
    const posExport = $("#posExport");
    if (posExport) posExport.onclick = () => copyText(positionExportText(), $("#posExportFeed"), "Monitor request");

    // ---- Outcome Lab / Expectancy ----
    const olRefresh = $("#olRefresh");
    if (olRefresh) olRefresh.onclick = () => refreshOutcomeLab();
    const olResolve = $("#olResolve");
    if (olResolve) olResolve.onclick = () => resolveOutcomeLab(olResolve);
  }

  /* ---------- live/demo data banner ---------- */
  function updateDataBanner() {
    const bar = $("#demoBar");
    const txt = $("#demoBarText");
    if (!bar || !txt) return;
    if (state.dataLive) {
      bar.classList.add("live");
      txt.innerHTML = `<b>LIVE DELTA PUBLIC DATA</b> — real Delta Exchange India market data via the backend (<code>/v2/products</code>, <code>/v2/tickers</code>, <code>/v2/history/candles</code>). Scan-only · no orders are placed. ${esc(state.backendNote)}`;
    } else {
      bar.classList.remove("live");
      txt.innerHTML = `<b>PREVIEW / DEMO DATA</b> — ${state.backendNote ? esc(state.backendNote) : "deterministic simulated numbers. Run a scan to reach the live Delta backend."}`;
    }
  }

  /* ---------- backend health probe (on load) ---------- */
  async function probeHealth() {
    if (!USE_BACKEND) return;
    try {
      const res = await fetch(API_BASE + "/api/health", { method: "GET" });
      if (!res.ok) throw new Error("health HTTP " + res.status);
      const h = await res.json();
      if (h && h.ok && h.delta_reachable) {
        state.dataLive = true;
        state.backendNote = `${h.data_source} reachable · probe ${h.probe_ms}ms`;
      } else {
        state.dataLive = false;
        state.backendNote = h && h.delta_reachable === false
          ? "Backend up but Delta feed unreachable — scans use DEMO data."
          : "Backend health check incomplete.";
      }
    } catch (e) {
      state.dataLive = false;
      state.backendNote = "No backend detected — run `npm start` to serve live Delta data. Showing DEMO data.";
    }
    updateDataBanner();
  }

  /* ---------- service worker (PWA install) ---------- */
  function registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(()=>{});
    }
  }

  /* ---------- init ---------- */
  function init() {
    renderStrategy();
    renderSettings();
    renderExec();
    renderAlerts();
    updateHeadMode();
    updateDataBanner();
    bindNav();
    bindControls();
    bindAutoWatch();
    bindTelegram();
    render();
    registerSW();
    probeHealth();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
