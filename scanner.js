/* scanner.js — Judas Cascade / Delta Scanner v4 strict 8-gate engine, ported
 * faithfully from delta-macd-bot/judas_8gate_bot.py. Pure functions + a public
 * Delta India REST client. No auth, no order placement. CommonJS module.
 */
"use strict";

const DEFAULT_BASE = "https://api.india.delta.exchange";
const TESTNET_BASE = "https://cdn-ind.testnet.deltaex.org";

const RES_SEC = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "1d": 86400,
};

const GATE_LABELS = [
  "FAMILY_QUALITY",
  "MTF_CASCADE",
  "RSI_CLEAN",
  "FUNDING_CLEAN",
  "JUDAS_SWEEP",
  "CUSUM_ALIGN",
  "STRUCTURAL_RR_SL",
  "LIQUIDITY_PRICE",
];

// Formation Radar: coarse readiness label from the 8-gate score. Presentation
// only — never changes the strict 8/8 verdict or the raw per-gate result.
function formationLabel(score8) {
  return score8 >= 8 ? "FORMED"
    : score8 === 7 ? "NEAR"
    : score8 === 6 ? "FORMING"
    : score8 === 5 ? "EARLY"
    : "IGNORE";
}

// Directional bias / "edge score" — a DETERMINISTIC, rule-based lean toward
// LONG vs SHORT from the live technical evidence the scanner already computed.
// It is NOT a probability, win rate, or exchange-PnL backtest; there is no
// persisted outcome store server-side, so this is live-evidence only.
// `+score` leans long, `-score` leans short. Returns chances summing to 100.
function directionalBias(d) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sgn = d.dir === "long" ? 1 : d.dir === "short" ? -1 : 0;
  const reasons = []; // { t, w(signed) } — sign shows long(+)/short(-) lean
  let score = 0;
  const add = (w, t) => { score += w; if (t) reasons.push({ t, w }); };

  // EMA cascade direction, weighted by family strength.
  if (sgn) add(sgn * (5 + 5 * clamp((d.famLong || 0) / 4, 0, 1)),
    `Cascade ${d.dir === "long" ? "UP" : "DOWN"}${d.famLong != null ? ` Fam ${d.famLong}/4` : ""}`);
  // MTF agreement points in the cascade direction.
  if (sgn && d.nTf) {
    const frac = clamp((d.mtfAgree || 0) / d.nTf, 0, 1);
    add(sgn * 10 * frac, `MTF ${d.mtfAgree || 0}/${d.nTf} ${d.dir === "long" ? "UP" : "DOWN"}`);
  }
  // CUSUM regime.
  if (d.cusumDir === "UP" || d.cusumDir === "DOWN") {
    const cs = clamp((d.cusumScore || 1) / 2, 0.3, 1);
    add((d.cusumDir === "UP" ? 1 : -1) * 12 * cs, `CUSUM ${d.cusumDir}`);
  }
  // RSI position relative to 50 (momentum lean), bounded.
  if (Number.isFinite(d.rsi)) {
    add(clamp((d.rsi - 50) / 15, -1, 1) * 7, `RSI ${d.rsi.toFixed(0)}`);
  }
  // Funding: crowded longs (high +funding) lean mean-revert short, and vice versa.
  if (Number.isFinite(d.fund) && d.fund !== 0) {
    add(clamp(-d.fund / 0.05, -1, 1) * 6,
      `Funding ${d.fund > 0 ? "+" : ""}${d.fund.toFixed(3)}%`);
  }
  // Judas sweep confirms the cascade direction.
  if (sgn && d.judasOk) add(sgn * 6, `Judas ${d.dir === "long" ? "UP" : "DOWN"}`);
  // VWAP / EMA location.
  if (d.vwapLoc === "above" || d.emaLoc === "above") add(5, "Price above VWAP/EMA");
  else if (d.vwapLoc === "below" || d.emaLoc === "below") add(-5, "Price below VWAP/EMA");

  const longChance = Math.round(50 + clamp(score, -45, 45));
  const shortChance = 100 - longChance;
  const gap = Math.abs(longChance - shortChance);
  const biasSide = gap < 10 ? "NEUTRAL" : (longChance > shortChance ? "LONG" : "SHORT");
  const strength = gap < 10 ? "Neutral" : gap < 25 ? "Mild" : gap < 45 ? "Moderate" : "Strong";
  const biasLabel = biasSide === "NEUTRAL" ? "Neutral"
    : `${strength} ${biasSide === "LONG" ? "Long" : "Short"} Bias`;
  // Reasons aligned with the winning side lead (then strongest), top 4, plus
  // the honesty note. NEUTRAL just orders by magnitude.
  const sideSign = biasSide === "LONG" ? 1 : biasSide === "SHORT" ? -1 : 0;
  const biasReasons = reasons
    .sort((a, b) => {
      const aa = sideSign && a.w * sideSign > 0, ba = sideSign && b.w * sideSign > 0;
      if (aa !== ba) return aa ? -1 : 1;
      return Math.abs(b.w) - Math.abs(a.w);
    })
    .slice(0, 4).map(x => x.t);
  biasReasons.push("live evidence (no PnL history)");
  return { longChance, shortChance, biasSide, biasConfidence: gap, biasLabel, biasReasons };
}

// Setup validity / freshness — a DETERMINISTIC, rule-based read of whether a
// scanned setup is still actionable right now: is the live price still near the
// reference entry, is the gate count strong, has price chased/stretched away,
// does the directional bias still agree, is the formation fresh? This is scanner
// freshness, NOT a guarantee, fill probability, or win rate. Returns a status,
// a 0-100 percentage, a label, and the top eroding/supporting reasons.
// `ageMin` (minutes since the scan) is optional; the server has no clock for a
// per-row scan time, so it is only supplied by the live client.
function validityFreshness(d) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const dir = d.dir;
  const s8 = d.score8 || 0;
  // No clear direction / no-trade / too few gates => INVALID outright.
  if (!dir || d.formation === "IGNORE" || s8 < 5) {
    const why = !dir ? "no direction" : d.formation === "IGNORE" ? "no-trade" : "too few gates";
    return { validityStatus: "INVALID", validityPct: 0, validityLabel: "Invalid — no clear setup",
      validityReasons: [why, "rule-based freshness"] };
  }

  const reasons = []; // { t, w } — w>0 supports validity, w<0 erodes it
  const add = (w, t) => { pct += w; if (t) reasons.push({ t, w }); };
  let pct = 50;

  // Gate completeness.
  if (d.passed || s8 >= 8) add(28, "8/8 gates");
  else if (s8 === 7) add(18, "7/8 gates");
  else if (s8 === 6) add(6, "6/8 forming");
  else add(-6, `${s8}/8 early`);

  // Live price vs the reference entry. `fav` > 0 means price already ran in the
  // trade's direction past entry (the move is being chased); < 0 means it has
  // pulled back the other way (structure may be weakening).
  const dpct = Math.abs(d.entryDeltaPct || 0);
  const fav = dir === "long" ? (d.entryDeltaPct || 0) : -(d.entryDeltaPct || 0);
  if (dpct <= 0.4) add(20, "near entry");
  else if (dpct <= 1.0) add(10, "near entry");
  else if (dpct <= 2.0) add(0, null);
  else if (dpct <= 4.0) add(-14, "price drifting");
  else add(-26, "price far from entry");
  if (fav > 2) add(-10, "entry chased");
  else if (fav < -3) add(-8, "structure weakening");
  else if (dpct <= 1.0) add(8, "not chased");

  // Overextension flags.
  if (d.stretched) add(-15, "too stretched");
  if (d.priceDiv) add(-8, "price divergence");

  // Directional bias agreement with the trade side.
  const bSide = d.biasSide === "LONG" ? "long" : d.biasSide === "SHORT" ? "short" : "neu";
  const biasConflict = bSide !== "neu" && bSide !== dir;
  if (bSide === dir) add(8, "bias aligned");
  else if (biasConflict) add(-12, "bias conflict");

  // Formation freshness.
  if (d.formation === "FORMED") add(6, null);
  else if (d.formation === "NEAR") add(2, null);
  else if (d.formation === "FORMING") add(-4, "forming");
  else if (d.formation === "EARLY") add(-10, "early");

  // RR sanity.
  if ((d.rr || 0) >= 2) add(5, "RR ok");
  else if (d.rr && d.rr < 1) add(-8, "thin RR");

  // Optional scan age (client-supplied only).
  if (Number.isFinite(d.ageMin)) {
    if (d.ageMin <= 3) add(6, "scan fresh");
    else if (d.ageMin <= 10) add(0, null);
    else if (d.ageMin <= 30) add(-8, "scan aging");
    else add(-18, "scan stale");
  }

  pct = Math.round(clamp(pct, 0, 100));

  const nearEntry = dpct <= 0.6 && fav <= 2;
  let validityStatus;
  if (biasConflict) validityStatus = pct < 35 ? "INVALID" : "STALE";
  else if (pct >= 72 && s8 >= 7 && nearEntry && !d.stretched) validityStatus = "FRESH";
  else if (pct >= 58) validityStatus = "VALID";
  else if (pct >= 40) validityStatus = "WATCH";
  else validityStatus = (s8 >= 6 && !d.stretched && fav < 2) ? "WATCH" : "STALE";

  const validityLabel = {
    FRESH: "Fresh — near plan", VALID: "Valid — actionable", WATCH: "Watch — wait for entry",
    STALE: "Stale — moved away", INVALID: "Invalid",
  }[validityStatus];

  // For strong statuses lead with supporting reasons; for weak ones lead with
  // what is eroding validity. Then by magnitude; top 3 + honesty tag.
  const wantPos = validityStatus === "FRESH" || validityStatus === "VALID";
  const validityReasons = reasons
    .sort((a, b) => {
      const aa = wantPos ? a.w > 0 : a.w < 0, ba = wantPos ? b.w > 0 : b.w < 0;
      if (aa !== ba) return aa ? -1 : 1;
      return Math.abs(b.w) - Math.abs(a.w);
    })
    .slice(0, 3).map(x => x.t);
  validityReasons.push("rule-based freshness");
  return { validityStatus, validityPct: pct, validityLabel, validityReasons };
}

/* ----------------------------- indicators ----------------------------- */
function emaSeries(vals, p) {
  if (vals.length < p) return null;
  const k = 2 / (p + 1);
  let seed = 0;
  for (let i = 0; i < p; i++) seed += vals[i];
  seed /= p;
  const out = new Array(p - 1).fill(null);
  let e = seed;
  out.push(e);
  for (let i = p; i < vals.length; i++) {
    e = vals[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
function emaLast(vals, p) {
  const s = emaSeries(vals, p);
  if (!s) return null;
  return s[s.length - 1];
}
function rsiSeries(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  g /= p; l /= p;
  const out = new Array(p).fill(null);
  out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
  }
  return out;
}
function atrLast(candles, p = 14) {
  if (candles.length < p + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  let a = 0;
  for (let i = 0; i < p; i++) a += tr[i];
  a /= p;
  for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
  return a;
}
function macdHist(closes) {
  const f = emaSeries(closes, 12);
  const s = emaSeries(closes, 26);
  if (!f || !s) return null;
  const macd = closes.map((_, i) =>
    (f[i] != null && s[i] != null) ? f[i] - s[i] : null);
  const valid = macd.filter(v => v != null);
  const sig = emaSeries(valid, 9);
  if (!sig) return null;
  const pad = macd.length - sig.length;
  const hist = [];
  for (let i = 0; i < macd.length; i++) {
    const si = i - pad;
    if (macd[i] != null && si >= 0 && sig[si] != null) hist.push(macd[i] - sig[si]);
    else hist.push(null);
  }
  return hist;
}
function bbPctb(closes, p = 20, k = 2) {
  if (closes.length < p) return null;
  const win = closes.slice(-p);
  const mean = win.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  const up = mean + k * sd, lo = mean - k * sd;
  if (up === lo) return 0.5;
  return (closes[closes.length - 1] - lo) / (up - lo);
}
function cusumRegime(closes, threshold = 1.0) {
  if (closes.length < 30) return ["FLAT", 0];
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 5) return ["FLAT", 0];
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  let sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) || 1e-9;
  let sHi = 0, sLo = 0, peakHi = 0, peakLo = 0;
  const drift = 0.5 * sd;
  for (const r of rets) {
    sHi = Math.max(0, sHi + (r - mean) - drift);
    sLo = Math.min(0, sLo + (r - mean) + drift);
    peakHi = Math.max(peakHi, sHi);
    peakLo = Math.min(peakLo, sLo);
  }
  const upScore = peakHi / sd;
  const dnScore = -peakLo / sd;
  if (upScore >= threshold && upScore >= dnScore) return ["UP", upScore];
  if (dnScore >= threshold && dnScore > upScore) return ["DOWN", dnScore];
  return ["FLAT", Math.max(upScore, dnScore)];
}
function volExhaust(candles) {
  if (candles.length < 22) return false;
  const seg = candles.slice(-21, -1);
  const avg = seg.reduce((a, c) => a + c.v, 0) / 20;
  const last = candles[candles.length - 1];
  return last.c < last.o && avg > 0 && last.v < 0.85 * avg;
}

/* Confirmatory volume read: ratio of the last candle's volume vs the prior
 * 20-candle average. >1 means expansion, <1 contraction. Returns null when not
 * enough candles or no average volume (avoids fabricating a confirmation). */
function volumeRatio(candles) {
  if (!candles || candles.length < 22) return null;
  const seg = candles.slice(-21, -1);
  const avg = seg.reduce((a, c) => a + c.v, 0) / 20;
  const last = candles[candles.length - 1];
  if (!(avg > 0)) return null;
  return last.v / avg;
}

/* Rolling VWAP over the most recent `n` candles (typical price * volume). Used
 * only as a price-location reference (above/below). Returns null when volume is
 * absent so we never fabricate a VWAP from zero-volume candles. */
function vwapLast(candles, n = 20) {
  if (!candles || candles.length < 5) return null;
  const seg = candles.slice(-n);
  let pv = 0, vol = 0;
  for (const c of seg) {
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v > 0 ? c.v : 0;
    pv += tp * v; vol += v;
  }
  if (!(vol > 0)) return null;
  return pv / vol;
}
function lastTwoPivots(arr, kind) {
  const piv = [];
  for (let i = 2; i < arr.length - 2; i++) {
    if (kind === "lo" && arr[i] < arr[i - 1] && arr[i] < arr[i - 2] && arr[i] < arr[i + 1] && arr[i] < arr[i + 2]) piv.push(i);
    if (kind === "hi" && arr[i] > arr[i - 1] && arr[i] > arr[i - 2] && arr[i] > arr[i + 1] && arr[i] > arr[i + 2]) piv.push(i);
  }
  return piv.slice(-2);
}
function macdDivergence(closes, hist) {
  if (!hist) return null;
  const n = Math.min(closes.length, hist.length);
  const cl = closes.slice(-Math.min(50, n));
  const hs = hist.slice(-Math.min(50, n)).map(x => x == null ? 0 : x);
  const lows = lastTwoPivots(cl, "lo");
  const highs = lastTwoPivots(cl, "hi");
  if (lows.length === 2 && cl[lows[1]] < cl[lows[0]] && hs[lows[1]] > hs[lows[0]]) return "long";
  if (highs.length === 2 && cl[highs[1]] > cl[highs[0]] && hs[highs[1]] < hs[highs[0]]) return "short";
  return null;
}
function judas(candles, mode, asH0, asH1) {
  if (candles.length < 12) return { dir: null };
  let hi = null, lo = null, postStart = null;
  if (mode === "asian") {
    let blk = [], best = null;
    for (let i = 0; i < candles.length; i++) {
      const hr = new Date(candles[i].t * 1000).getUTCHours();
      const inb = asH1 > asH0 ? (asH0 <= hr && hr < asH1) : (hr >= asH0 || hr < asH1);
      if (inb) blk.push(i);
      else if (blk.length) { best = blk.slice(); blk = []; }
    }
    if (best === null && blk.length) best = blk;
    if (!best || best.length < 2) return { dir: null };
    postStart = best[best.length - 1] + 1;
    hi = Math.max(...best.map(i => candles[i].h));
    lo = Math.min(...best.map(i => candles[i].l));
  } else {
    const step = (candles[1].t - candles[0].t) || 900;
    const look = Math.min(candles.length - 1, Math.round(86400 / step));
    const win = candles.slice(-Math.max(look, 16), -6);
    if (win.length < 6) return { dir: null };
    hi = Math.max(...win.map(k => k.h));
    lo = Math.min(...win.map(k => k.l));
    postStart = candles.length - 6;
  }
  const post = candles.slice(postStart);
  if (post.length < 1) return { dir: null };
  const last = candles[candles.length - 1].c;
  const sweptDown = post.some(k => k.l < lo);
  const reclaimUp = post.some((k, idx) =>
    post[idx].l < lo && post.slice(idx).some(j => j.c > lo));
  const sweptUp = post.some(k => k.h > hi);
  const reclaimDn = post.some((k, idx) =>
    post[idx].h > hi && post.slice(idx).some(j => j.c < hi));
  let direction = null;
  if (sweptDown && reclaimUp && last > lo) direction = "long";
  else if (sweptUp && reclaimDn && last < hi) direction = "short";
  return { dir: direction, rangeHi: hi, rangeLo: lo };
}

/* Structural take-profit: the opposite-side liquidity pool revealed by the
 * judas sweep (the range high for longs, the range low for shorts). Returns
 * { tp, rr } when it forms a valid same-direction reward, else null. Additive
 * context only — it never replaces the gate-bearing fixed-RR target. */
function structuralTarget(side, entry, stop, rangeHi, rangeLo) {
  if (entry == null || stop == null) return null;
  const cand = side === "long" ? rangeHi : side === "short" ? rangeLo : null;
  if (cand == null) return null;
  const risk = side === "long" ? entry - stop : stop - entry;
  const reward = side === "long" ? cand - entry : entry - cand;
  if (!(risk > 0) || !(reward > 0)) return null;
  return { tp: cand, rr: reward / risk };
}

/* Funding crowding classification (req #5): funding as a SIGNAL, not only a veto.
 * `fund` is the signed funding rate (%) after funding_mult. Returns a state and a
 * bounded directional alpha lean (+ leans long / fade crowded shorts, − leans
 * short / fade crowded longs). NOT a probability. */
function classifyFunding(fund, cfg) {
  if (fund == null || !Number.isFinite(fund)) return { fundingState: "unknown", fundingAlpha: null };
  const crowd = Math.max(1e-9, (cfg && cfg.funding_block_pct) || 0.05);
  const extreme = Math.max(crowd, (cfg && cfg.funding_extreme_pct) || crowd * 3);
  const alpha = +Math.max(-1, Math.min(1, -fund / extreme)).toFixed(3); // fade lean
  if (Math.abs(fund) >= extreme) return { fundingState: "extreme_veto", fundingAlpha: alpha };
  if (fund >= crowd) return { fundingState: "crowded_long_fade_short", fundingAlpha: alpha };
  if (fund <= -crowd) return { fundingState: "crowded_short_fade_long", fundingAlpha: alpha };
  return { fundingState: "neutral", fundingAlpha: alpha };
}

/* Funding as a SIGNAL relative to the trade direction (req #5). Crowding is a
 * tailwind when the trade fades the crowd and a headwind when it joins it; mild/
 * neutral funding is just "neutral" and must NOT manufacture confidence. Returns
 *   favor   — funding crowding supports fading into this direction
 *   against — this direction joins the crowd (funding is a headwind)
 *   veto    — funding is extreme (unsafe to trade either way)
 *   neutral — no meaningful funding edge. */
function fundingSignalFor(fundingState, dir) {
  if (fundingState === "extreme_veto") return "veto";
  if (!dir || fundingState === "neutral" || fundingState === "unknown") return "neutral";
  if (fundingState === "crowded_long_fade_short") return dir === "short" ? "favor" : "against";
  if (fundingState === "crowded_short_fade_long") return dir === "long" ? "favor" : "against";
  return "neutral";
}

/* Correlated-exposure group (req #6): so the UI/execution can cap correlated alt
 * entries as one position and neutralize BTC beta. Coarse base-symbol bucketing. */
const MAJOR_BASES = new Set(["SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "LINK", "TRX", "DOT", "MATIC", "LTC", "BCH", "TON", "NEAR", "APT"]);
function exposureGroup(symbol, quote) {
  let base = String(symbol || "").toUpperCase();
  for (const q of [quote, "USDT", "USDC", "USD"]) {
    if (q && base.endsWith(q)) { base = base.slice(0, base.length - q.length); break; }
  }
  base = base.replace(/[_\-]+$/, "");
  if (base.startsWith("BTC") || base === "XBT") return "BTC";
  if (base.startsWith("ETH")) return "ETH";
  if (MAJOR_BASES.has(base)) return "MAJOR";
  return "ALT";
}

/* BTC market-regime alignment for a trade direction (req #6). `regime` is the
 * marketRegime() result. Returns aligned | counter | flat | unknown. */
function btcRegimeAlign(regime, dir) {
  if (!regime || !regime.available || !regime.bias || regime.bias === "FLAT") return "flat";
  if (!dir) return "unknown";
  const up = regime.bias === "UP";
  if ((up && dir === "long") || (!up && dir === "short")) return "aligned";
  return "counter";
}

/* Beta gate (req #6): cap alt entries that fight a strong BTC regime. BTC itself
 * is always ok. Counter to a STRONG regime → block; counter to a weak one →
 * caution; aligned/flat → ok. Returns ok | caution | block. */
function betaGate(regime, dir, group) {
  if (group === "BTC") return "ok";
  const align = btcRegimeAlign(regime, dir);
  if (align === "counter") {
    const strong = regime && Number.isFinite(regime.strength) && regime.strength >= 1.0;
    return strong ? "block" : "caution";
  }
  return "ok";
}

/* Simplified, honest execution status (req #3) derived from freshness + plan
 * validity. ENTER (near plan, valid) / WAIT (forming or away from entry) /
 * AVOID (invalid, stale, or no-trade). Beta-gate downgrades applied server-side. */
function execStatusBase(dir, vstatus, deltaPct, noTradeReason) {
  if (noTradeReason) return "AVOID";
  if (!dir || vstatus === "INVALID" || vstatus === "STALE") return "AVOID";
  if ((vstatus === "FRESH" || vstatus === "VALID") && Math.abs(deltaPct || 0) <= 1.0) return "ENTER";
  return "WAIT";
}

function tkNum(t, ...keys) {
  for (const k of keys) {
    const v = t[k];
    if (v == null || v === "") continue;
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

/* ----------------------------- REST client ----------------------------- */
class DeltaPublic {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = cfg.base_url || DEFAULT_BASE;
    this.ua = cfg.user_agent || "node-judas-8gate-bot";
  }
  _url(path) { return `${this.cfg.cors_proxy || ""}${this.base}${path}`; }
  async _get(path) {
    // Retry transient failures (network errors, request timeout, HTTP 429 and
    // 5xx) with exponential backoff + jitter. Permanent client errors (other
    // 4xx) fail fast. Public read-only requests only — no auth, no orders.
    const tries = Math.max(1, this.cfg.max_retries != null ? +this.cfg.max_retries : 3);
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      let permanent = false;
      try {
        const res = await fetch(this._url(path), {
          headers: { accept: "application/json", "User-Agent": this.ua },
          signal: AbortSignal.timeout(20000),
        });
        if (res.ok) return res.json();
        permanent = !(res.status === 429 || res.status >= 500);
        lastErr = new Error(`HTTP ${res.status} for ${path}`);
        if (permanent) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (permanent) throw lastErr; // do not retry permanent client errors
      }
      if (i < tries - 1) {
        const backoff = Math.min(2000, 200 * 2 ** i) + Math.floor(Math.random() * 120);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }
  async products() {
    const j = await this._get("/v2/products?states=live&page_size=1000");
    const out = new Set();
    for (const p of (j.result || [])) {
      if (String(p.contract_type || "").toLowerCase() === "perpetual_futures" && p.symbol) out.add(p.symbol);
    }
    return out;
  }
  async tickers() {
    const j = await this._get("/v2/tickers");
    const m = {};
    for (const t of (j.result || [])) m[t.symbol] = t;
    return m;
  }
  async candles(symbol, res, bars) {
    const sec = RES_SEC[res] || 900;
    const end = Math.floor(Date.now() / 1000);
    const start = end - sec * (bars + 5);
    const path = `/v2/history/candles?resolution=${res}&symbol=${encodeURIComponent(symbol)}&start=${start}&end=${end}`;
    let j;
    try { j = await this._get(path); } catch (e) { return null; }
    const rows = j.result || [];
    if (!rows.length) return null;
    const c = [];
    for (const k of rows) {
      const row = {
        t: parseInt(k.time, 10),
        o: parseFloat(k.open), h: parseFloat(k.high),
        l: parseFloat(k.low), c: parseFloat(k.close),
        v: parseFloat(k.volume || 0) || 0,
      };
      if (Number.isFinite(row.c)) c.push(row);
    }
    c.sort((a, b) => a.t - b.t);
    return c.length ? c : null;
  }
}

/* ----------------------------- 8-gate analysis ----------------------------- */
function allTimeframes(cfg) {
  const tfs = cfg.mtf_timeframes.map(t => t.trim()).filter(Boolean);
  if (!tfs.includes(cfg.entry_tf)) return tfs.concat([cfg.entry_tf]);
  return tfs;
}

async function analyze(symbol, ticker, client, cfg) {
  const tfs = allTimeframes(cfg);
  const candleMap = {};
  for (const tf of tfs) {
    const bars = (RES_SEC[tf] || 900) <= 900 ? 140 : 40;
    candleMap[tf] = await client.candles(symbol, tf, bars);
  }
  if (tfs.some(tf => candleMap[tf] == null)) return { sym: symbol, err: "no data" };

  const dirTf = (c) => {
    const cl = c.map(x => x.c);
    const ef = emaLast(cl, cfg.ema_fast);
    const es = emaLast(cl, cfg.ema_slow);
    if (ef == null || es == null) return null;
    return ef > es ? "long" : ef < es ? "short" : null;
  };

  const mtfTfs = cfg.mtf_timeframes.map(t => t.trim()).filter(Boolean);
  const dirs = mtfTfs.map(tf => dirTf(candleMap[tf]));
  const nTf = dirs.length;
  const cascade = (dirs.length && dirs.every(d => d != null && d === dirs[0])) ? dirs[0] : null;
  const mtfAgree = dirs.filter(d => d != null && cascade != null && d === cascade).length;

  const ent = candleMap[cfg.entry_tf];
  const closes = ent.map(x => x.c);
  const price = closes[closes.length - 1];
  const rsiArr = rsiSeries(closes, 14);
  const rsi = rsiArr ? rsiArr[rsiArr.length - 1] : null;
  const atr = atrLast(ent, 14);
  const ema50 = emaLast(closes, 50);
  const hist = macdHist(closes);
  const pctb = bbPctb(closes, 20, 2);
  const j = judas(ent, cfg.judas_mode, cfg.asian_start_h, cfg.asian_end_h);
  const [cusumDir, cusumScore] = cusumRegime(closes, cfg.cusum_threshold);

  const rawFund = tkNum(ticker, "funding_rate", "funding_rate_8h");
  const fund = rawFund == null ? null : rawFund * cfg.funding_mult;
  const fundClean = fund != null && Math.abs(fund) <= cfg.funding_block_pct;
  let fundDirOk = true;
  if (fund != null && cascade != null) {
    fundDirOk = cascade === "long" ? fund <= cfg.funding_block_pct : fund >= -cfg.funding_block_pct;
  }

  let mark = tkNum(ticker, "mark_price", "spot_price", "close");
  mark = mark != null ? mark : price;
  const priceDiv = Math.abs(price - mark) / (mark || price);
  const priceIntegrity = priceDiv <= 0.05;

  let hi = cfg.rsi_hi, lo = cfg.rsi_lo;
  if (cfg.rsi_adapt === "trend" && ema50 != null) {
    const up = price > ema50;
    hi = up ? 70 : 65;
    lo = up ? 30 : 35;
  }
  const midline = 50;
  let rsiClean, rsiThr;
  if (cascade === "long") { rsiClean = rsi != null && midline <= rsi && rsi < hi; rsiThr = midline; }
  else if (cascade === "short") { rsiClean = rsi != null && lo < rsi && rsi <= midline; rsiThr = midline; }
  else { rsiClean = false; rsiThr = midline; }

  const div = macdDivergence(closes, hist);
  const exhausted = volExhaust(ent);
  const stretchPct = ema50 != null ? Math.abs(price - ema50) / ema50 * 100 : null;
  const stretched = stretchPct != null && stretchPct > cfg.ema50_stretch_pct;
  const bbLong = pctb != null && pctb < 0.25;
  const bbShort = pctb != null && pctb > 0.75;

  const gMacd = cfg.macd_divergence === "require" ? (div === cascade) : true;
  const gVol = cfg.vol_exhaustion === "require" ? exhausted : true;
  const gBb = cfg.bb_position === "require"
    ? (cascade === "long" ? bbLong : cascade === "short" ? bbShort : false)
    : true;

  const judasOk = !!(j.dir && j.dir === cascade);

  // structural stop / target
  const entry = price;
  let stop = null, target = null, rr = cfg.rr_target;
  if (cascade && atr) {
    const volF = cfg.atr_dynamic === "vol" ? Math.min(2.5, Math.max(0.5, (atr / entry) / 0.02)) : 1.0;
    const dist = atr * cfg.atr_mult * volF;
    if (cfg.rr_dynamic === "vol") rr = Math.max(1.5, cfg.rr_target / volF);
    if (cascade === "long") {
      const s = (j.rangeLo != null ? j.rangeLo : entry - dist) - 0.1 * atr;
      stop = Math.min(entry - dist, s);
      target = entry + rr * (entry - stop);
    } else {
      const s = (j.rangeHi != null ? j.rangeHi : entry + dist) + 0.1 * atr;
      stop = Math.max(entry + dist, s);
      target = entry - rr * (stop - entry);
    }
  }

  let structOk = false, actualRr = null;
  if (cascade && stop != null && target != null) {
    let validSides, risk, reward;
    if (cascade === "long") { validSides = stop < entry && entry < target; risk = entry - stop; reward = target - entry; }
    else { validSides = target < entry && entry < stop; risk = stop - entry; reward = entry - target; }
    if (validSides && risk > 0) { actualRr = reward / risk; structOk = actualRr >= (cfg.rr_target - 1e-9); }
  }

  // ---- Structural vs fixed target metadata (ADDITIVE) ----
  // The primary `target`/`rr` above remain the fixed-RR projection that the
  // STRUCTURAL_RR_SL gate depends on — unchanged. These extra fields expose the
  // same fixed target plus an alternative structural target (opposite-side
  // liquidity), so the UI / Outcome Lab can compare them. Pure context.
  const tpFixed = target;                                   // fixed-RR projection (pre-override)
  const rrFixed = actualRr != null ? actualRr : (cascade ? rr : null);
  const st = structuralTarget(cascade, entry, stop, j.rangeHi, j.rangeLo);
  const tpStruct = st ? st.tp : null;
  const rrStruct = st ? st.rr : null;
  let targetMode = "fixed_rr"; // primary target source (may switch to structural)
  let noTradeReason = null;
  // Structural-first targeting (req #4, opt-in). Default keeps the fixed-RR plan
  // as primary so the live app is byte-for-byte unchanged. When enabled, the
  // structural (opposite-side liquidity) target becomes the primary plan with a
  // floating RR; below rr_floor it is a no-trade (fails the plan gate).
  if (cfg.target_mode === "structural_first" && cascade && stop != null) {
    targetMode = "structural";
    if (st && st.rr >= (cfg.rr_floor - 1e-9)) {
      target = st.tp;
      actualRr = st.rr;
      structOk = true;
    } else {
      structOk = false;
      noTradeReason = st ? "structural RR below floor" : "no structural target";
    }
  }
  const entryTime = ent.length ? ent[ent.length - 1].t * 1000 : null; // ms epoch
  const entryTf = cfg.entry_tf;

  // 4-family quality score
  let score4 = 0, famLong = 0;
  if (cascade) {
    const agree = mtfAgree / Math.max(1, nTf);
    const structFam = judasOk ? 1.0 : (j.dir ? 0.4 : 0.0);
    const flow = fund != null ? Math.max(0, 1 - Math.abs(fund) / Math.max(cfg.funding_block_pct, 1e-9)) : 0.0;
    let mom = 0.0;
    if (rsi != null) {
      mom = cascade === "long"
        ? Math.max(0, Math.min(1, (hi - rsi) / hi))
        : Math.max(0, Math.min(1, (rsi - lo) / (100 - lo)));
    }
    const fams = [agree, structFam, flow, mom];
    famLong = fams.filter(f => f >= 0.5).length;
    score4 = Math.round(25 * fams.reduce((a, b) => a + b, 0));
  }

  const cusumAlign = (cusumDir === "UP" && cascade === "long") || (cusumDir === "DOWN" && cascade === "short");

  const turnover = tkNum(ticker, "turnover_usd", "turnover", "mark_volume") || 0;
  const quoteOk = (!cfg.quote_filter) || symbol.endsWith(cfg.quote_filter);
  const liqOk = priceIntegrity && turnover >= cfg.min_turnover && quoteOk;

  /* ---- Confirmatory-layer signals (additive context; do NOT change gates) ----
   * Everything here is a deterministic read of data the engine already has, or
   * graceful null when the source is absent. The 8-gate verdict is untouched. */
  // Open interest — only if the Delta ticker exposes it. Never fabricated.
  const oi = tkNum(ticker, "oi", "open_interest", "oi_value_usd", "oi_contracts");
  const oiUsd = tkNum(ticker, "oi_value_usd", "oi_usd");
  // Volume confirmation: last entry-TF candle volume vs prior 20-candle average.
  const volRatio = volumeRatio(ent);
  // Price location vs rolling VWAP and the 50-EMA trend on the entry timeframe.
  const vwap = vwapLast(ent, 20);
  const vwapLoc = vwap == null ? null : (price > vwap ? "above" : price < vwap ? "below" : "at");
  const emaLoc = ema50 == null ? null : (price > ema50 ? "above" : price < ema50 ? "below" : "at");
  // Liquidity quality proxy: 24h turnover band (spread is not in public ticker).
  const liqQuality = turnover >= Math.max(cfg.min_turnover, 5e6) ? "ok"
    : turnover >= Math.max(cfg.min_turnover, 1e6) ? "moderate" : "thin";

  const gates = {
    FAMILY_QUALITY: !!cascade && score4 >= cfg.family_score_floor,
    MTF_CASCADE: cascade != null && mtfAgree === nTf && nTf > 0,
    RSI_CLEAN: !!(rsiClean && gMacd && gVol && gBb),
    FUNDING_CLEAN: !!(fundClean && fundDirOk),
    JUDAS_SWEEP: judasOk,
    CUSUM_ALIGN: !!cusumAlign,
    STRUCTURAL_RR_SL: !!structOk,
    LIQUIDITY_PRICE: !!liqOk,
  };
  const gateList = GATE_LABELS.map(l => !!gates[l]);
  const score8 = gateList.filter(Boolean).length;
  const passed = gateList.every(Boolean);
  // Formation Radar: combined readiness label + the gates still missing. This
  // is presentation/context only — it never alters the strict 8/8 verdict.
  const missingGates = GATE_LABELS.filter(l => !gates[l]);
  const formation = formationLabel(score8);
  const bias = directionalBias({
    dir: cascade, famLong, mtfAgree, nTf, rsi, cusumDir, cusumScore,
    fund, judasOk, vwapLoc, emaLoc,
  });

  // Current/mark price for live execution validation. `entry` is the last
  // closed-candle price (the plan's reference entry); `mark` is the live mark
  // price from the ticker (or last close if absent). The UI compares mark vs
  // entry to decide Enter Now / Wait / Avoid.
  const curPrice = mark != null ? mark : price;
  const entryDeltaPct = entry ? (curPrice - entry) / entry * 100 : 0;
  const validity = validityFreshness({
    dir: cascade, score8, passed, formation, entryDeltaPct, stretched, priceDiv,
    biasSide: bias.biasSide, rr: actualRr != null ? actualRr : rr,
  });

  /* ---- Honest 4-family rollup (req #2/#3) -------------------------------
   * The 8 gates are NOT independent (FAMILY_QUALITY rolls up the others; MTF/
   * CUSUM/RSI are all trend evidence). Collapse them into 4 de-correlated
   * families so the UI can stop presenting 8 "independent" confirmations:
   *   direction (trend) · structure (sweep) · funding (crowding) · execution. */
  const funding = classifyFunding(fund, cfg);
  const fundingSignal = fundingSignalFor(funding.fundingState, cascade);
  // Funding is now a SIGNAL, not a blunt veto: the funding family passes when
  // crowding is a tailwind ("favor") or absent ("neutral"), and fails when this
  // trade joins the crowd ("against") or funding is extreme ("veto"). Mild funding
  // no longer manufactures confidence, and contrarian fades are rewarded.
  const families = {
    direction: !!(cascade && gates.MTF_CASCADE && gates.CUSUM_ALIGN && gates.RSI_CLEAN),
    structure: !!gates.JUDAS_SWEEP,
    funding: !!cascade && (fundingSignal === "favor" || fundingSignal === "neutral"),
    execution: !!(gates.LIQUIDITY_PRICE && gates.STRUCTURAL_RR_SL),
  };
  const familyList = [families.direction, families.structure, families.funding, families.execution];
  const familyScore = familyList.filter(Boolean).length;
  // Honest verdict: a setup is "clean" only when all four DE-CORRELATED families
  // agree, the structural plan is tradeable (no no-trade reason), and the rollup
  // quality clears its floor. This replaces "seven correlated labels agree" — the
  // legacy strict 8/8 `passed` is kept as a separate field for backward compat.
  const corePass = familyScore === 4 && score4 >= cfg.family_score_floor && !noTradeReason;
  const honestVerdict = corePass ? "CLEAN" : familyScore >= 3 ? "WATCH" : "SKIP";
  const correlatedExposureGroup = exposureGroup(symbol, cfg.quote_filter);
  const executionStatus = execStatusBase(cascade, validity.validityStatus, entryDeltaPct, noTradeReason);

  return {
    sym: symbol, err: null, dir: cascade, score8, gates, gateList, passed,
    missingGates, formation,
    longChance: bias.longChance, shortChance: bias.shortChance,
    biasSide: bias.biasSide, biasConfidence: bias.biasConfidence,
    biasLabel: bias.biasLabel, biasReasons: bias.biasReasons,
    validityStatus: validity.validityStatus, validityPct: validity.validityPct,
    validityLabel: validity.validityLabel, validityReasons: validity.validityReasons,
    famLong, score4, mtfAgree, nTf, rsi, rsiThr,
    fund, fundClean, cusumDir, cusumScore, judasOk, priceDiv, stretched,
    entry, stop, target, rr: actualRr != null ? actualRr : rr, turnover,
    price, mark: curPrice, entryDeltaPct,
    slPct: stop != null ? Math.abs(entry - stop) / entry * 100 : 0,
    tpPct: target != null ? Math.abs(target - entry) / entry * 100 : 0,
    // ---- structural vs fixed target metadata (additive context) ----
    tpFixed, rrFixed, tpStruct, rrStruct, targetMode, entryTime, entryTf,
    noTradeReason, rrFloor: cfg.rr_floor, timeStopBars: cfg.time_stop_bars,
    // ---- honest 4-family rollup + simplified labels (req #2/#3) ----
    families, familyList, familyScore, corePass,
    honestVerdict,                // CLEAN / WATCH / SKIP — the honest headline label
    setupState: formation,        // FORMED/NEAR/FORMING/EARLY/IGNORE (honest state)
    executionStatus,              // ENTER/WAIT/AVOID (beta-gate applied server-side)
    // ---- funding crowding (req #5): signal, not only veto ----
    fundingState: funding.fundingState, fundingAlpha: funding.fundingAlpha,
    fundingSignal,                // favor / against / neutral / veto (vs trade dir)
    // ---- correlated-exposure / BTC-beta context (req #6) ----
    correlatedExposureGroup,
    // btcRegimeAlign + betaGate are annotated server-side (need the scan regime).
    // ---- judas session model (req #7): expose mode + swept range ----
    judasMode: cfg.judas_mode,
    judasRangeHi: (j && j.rangeHi != null) ? j.rangeHi : null,
    judasRangeLo: (j && j.rangeLo != null) ? j.rangeLo : null,
    // NOTE: longChance/shortChance/biasConfidence below are a DEPRECATED,
    // non-probability directional lean kept only for backward compatibility
    // (cron/email/older PWA). Do NOT present them as win probabilities.
    // ---- confirmatory-layer signals (additive; null when source absent) ----
    oi: oi != null ? oi : null,
    oiUsd: oiUsd != null ? oiUsd : null,
    volRatio: volRatio != null ? +volRatio.toFixed(3) : null,
    vwap: vwap != null ? vwap : null,
    vwapLoc, emaLoc, ema50: ema50 != null ? ema50 : null,
    liqQuality,
  };
}

function selectUniverse(tickers, perps, cfg) {
  let syms = Object.keys(tickers).filter(s => perps.has(s));
  if (cfg.quote_filter) syms = syms.filter(s => s.endsWith(cfg.quote_filter));
  if (cfg.min_turnover > 0) syms = syms.filter(s => (tkNum(tickers[s], "turnover_usd", "turnover") || 0) >= cfg.min_turnover);
  syms.sort((a, b) => (tkNum(tickers[b], "turnover_usd", "turnover") || 0) - (tkNum(tickers[a], "turnover_usd", "turnover") || 0));
  return syms.slice(0, cfg.max_symbols);
}

// Run analyze with limited concurrency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { sym: items[i], err: String(e && e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

async function scan(cfg, client) {
  const perps = await client.products();
  const tickers = await client.tickers();
  const syms = selectUniverse(tickers, perps, cfg);
  return mapLimit(syms, cfg.concurrency, (s) => analyze(s, tickers[s], client, cfg));
}

/* ----------------------------- market regime ----------------------------- */
/* Derive a coarse BTC/ETH market-regime read from public candles so the
 * Confirmatory layer can ask "is the broad market with or against this trade?".
 * It is a deterministic CUSUM read on BTC (with ETH as a tie-breaker) over the
 * entry timeframe — NOT a probability or forecast. Returns a graceful
 * { available:false } object if BTC data cannot be fetched. */
async function marketRegime(client, cfg) {
  const tf = cfg.entry_tf || "15m";
  const pickSym = (base) => {
    // Delta India perp symbols are typically BTCUSD / ETHUSD (USDT variants too).
    const cands = [`${base}USD`, `${base}USDT`, `${base}_USDT`, `${base}USDC`];
    return cands;
  };
  const regimeFor = async (base) => {
    for (const sym of pickSym(base)) {
      const c = await client.candles(sym, tf, 80);
      if (c && c.length >= 30) {
        const [dir, score] = cusumRegime(c.map(x => x.c), cfg.cusum_threshold);
        return { sym, dir, score: +(+score).toFixed(2) };
      }
    }
    return null;
  };
  try {
    const btc = await regimeFor("BTC");
    if (!btc) return { available: false, note: "BTC market data unavailable" };
    const eth = await regimeFor("ETH");
    // Overall bias: BTC drives; ETH only confirms/strengthens.
    let bias = btc.dir; // UP | DOWN | FLAT
    let strength = btc.score;
    if (eth) {
      if (eth.dir === btc.dir && btc.dir !== "FLAT") strength = Math.max(strength, (btc.score + eth.score) / 2);
      else if (btc.dir === "FLAT" && eth.dir !== "FLAT") { bias = eth.dir; strength = eth.score; }
    }
    return {
      available: true,
      tf,
      bias,                 // UP | DOWN | FLAT
      strength,             // CUSUM std units (not a probability)
      btc, eth: eth || null,
    };
  } catch (e) {
    return { available: false, note: "market regime probe failed: " + String(e && e.message || e) };
  }
}

/* ----------------------------- report formatting ----------------------------- */
function fmtPrice(v) {
  if (v == null) return "0";
  let s = v.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return s || "0";
}

function formatScan(results, cfg) {
  const now = new Date().toISOString().slice(11, 16);
  // The honest model leads: in strict mode we keep CLEAN setups (all four
  // de-correlated families agree AND the structural plan is tradeable), not the
  // legacy "strict 8/8". score8 is still printed as a legacy diagnostic.
  let kept;
  if (cfg.strict) kept = results.filter(r => !r.err && (r.corePass || r.passed));
  else kept = results.filter(r => !r.err && r.dir && (r.familyScore || 0) >= 3);
  kept.sort((a, b) => (b.familyScore - a.familyScore) || (b.score4 - a.score4) || (b.score8 - a.score8));

  const lines = [];
  lines.push(`DELTA SCANNER v6 — ${now} UTC — structural-first, measured`);
  const crit = cfg.strict ? "CLEAN (4-family + tradeable structure)" : "3+/4 families (watch)";
  lines.push(`${kept.length} setup(s) — ${crit}`);
  lines.push("=".repeat(55));
  lines.push("");
  for (const r of kept) {
    const d = (r.dir || "").toUpperCase();
    const entry = r.entry, stop = r.stop, target = r.target;
    const slPct = (stop && entry) ? Math.abs(entry - stop) / entry * 100 : 0;
    const tpPct = (target && entry) ? Math.abs(target - entry) / entry * 100 : 0;
    const rsi = r.rsi, fund = r.fund;
    const gatesStr = r.gateList.map(g => g ? "Y" : "N").join(" ");
    const fam = r.familyList
      ? ["Dir", "Struct", "Fund", "Exec"].map((t, i) => `${t}:${r.familyList[i] ? "Y" : "N"}`).join(" ")
      : "";
    // Honest headline: verdict + families + funding signal + execution + beta.
    lines.push(`${r.sym} ${d}  ${r.honestVerdict || "-"}  Families:${r.familyScore || 0}/4 [${fam}]`);
    lines.push(`Target:${r.targetMode}  Entry:$${fmtPrice(entry)}  SL:$${fmtPrice(stop)}(${slPct.toFixed(2)}%)  TP:$${fmtPrice(target)}(${tpPct.toFixed(2)}%)  RR:${(r.rr != null ? r.rr : 0).toFixed(2)}${r.noTradeReason ? `  [NO-TRADE: ${r.noTradeReason}]` : ""}`);
    lines.push(`Funding:${r.fundingState || "-"}→${r.fundingSignal || "-"}  Exec:${r.executionStatus || "-"}  BTCbeta:${r.btcRegimeAlign || "-"}/${r.betaGate || "-"}  Group:${r.correlatedExposureGroup || "-"}  Time-stop:${r.timeStopBars || "-"}b`);
    if (r.correlatedExposureWarning) lines.push(`⚠ ${r.correlatedExposureWarning}`);
    // Legacy diagnostics (kept for compatibility; not the headline anymore).
    lines.push(`[legacy] Score:${r.score8}/8 Gates:${gatesStr} · MTF:${r.mtfAgree}/${r.nTf} RSI:${(rsi != null ? rsi : 0).toFixed(1)} CUSUM:${r.cusumDir} FR:${(fund != null ? fund : 0).toFixed(4)}% · Lean(non-prob):${r.biasSide} ${r.longChance}/${r.shortChance}`);
    lines.push("");
  }
  if (!kept.length) lines.push("(no qualifying setups this scan)");

  // ---- Formation Radar sections (context only; never affects the verdict) ----
  // NEAR = 7/8 (one gate away), FORMING = 5-6/8 (one or two gates away). A coin
  // already in the strict-kept list above is not repeated here.
  const keptSet = new Set(kept.map(r => r.sym));
  const near = results.filter(r => !r.err && r.dir && r.score8 === 7 && !keptSet.has(r.sym))
    .sort((a, b) => (b.score4 - a.score4));
  const forming = results.filter(r => !r.err && r.dir && (r.score8 === 5 || r.score8 === 6) && !keptSet.has(r.sym))
    .sort((a, b) => (b.score8 - a.score8) || (b.score4 - a.score4));
  const compactLine = (r) => {
    const d = (r.dir || "").toUpperCase();
    const miss = (r.missingGates || []).join(",") || "—";
    return `${r.sym} ${d} ${r.score8}/8 · bias:${r.biasSide[0]} ${r.longChance}/${r.shortChance} · val:${r.validityStatus} ${r.validityPct} · miss:${miss}`;
  };
  if (near.length) {
    lines.push("");
    lines.push("-".repeat(55));
    lines.push(`NEAR (7/8 — one gate away) · ${near.length}`);
    near.forEach(r => lines.push(compactLine(r)));
  }
  if (forming.length) {
    lines.push("");
    lines.push("-".repeat(55));
    lines.push(`FORMING (5-6/8 — watchlist) · ${forming.length}`);
    forming.slice(0, 25).forEach(r => lines.push(compactLine(r)));
    if (forming.length > 25) lines.push(`… +${forming.length - 25} more`);
  }
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

/* ----------------------------- config builder ----------------------------- */
function buildConfig(payload = {}) {
  const p = payload || {};
  const num = (v, d) => { const f = parseFloat(v); return Number.isFinite(f) ? f : d; };
  const str = (v, d) => (v == null || v === "" ? d : String(v));
  let mtf = p.mtf_timeframes;
  if (Array.isArray(mtf)) mtf = mtf.map(String);
  else mtf = String(mtf || "4h,1h,15m").split(",");
  return {
    base_url: DEFAULT_BASE,
    cors_proxy: "", // server-side never needs a CORS proxy
    user_agent: "node-judas-8gate-bot",
    account_size: num(p.account_size, 1000),
    risk_pct: num(p.risk_pct, 1),
    rsi_hi: num(p.rsi_hi, 65),
    rsi_lo: num(p.rsi_lo, 35),
    rsi_adapt: str(p.rsi_adapt, "trend"),
    funding_block_pct: num(p.funding_block_pct, 0.05),
    funding_mult: num(p.funding_mult, 1),
    atr_mult: num(p.atr_mult, 1.5),
    atr_dynamic: str(p.atr_dynamic, "vol"),
    ema_fast: Math.round(num(p.ema_fast, 9)),
    ema_slow: Math.round(num(p.ema_slow, 21)),
    ema50_stretch_pct: num(p.ema50_stretch_pct, 8),
    entry_tf: str(p.entry_tf, "15m"),
    mtf_timeframes: mtf,
    judas_mode: str(p.judas_mode, "asian"),
    asian_start_h: Math.round(num(p.asian_start, num(p.asian_start_h, 0))),
    asian_end_h: Math.round(num(p.asian_end, num(p.asian_end_h, 6))),
    rr_target: num(p.rr_target, 2),
    rr_dynamic: str(p.rr_dynamic, "fixed"),
    // Targeting model (req #4). DEFAULT "structural_first": the primary target is
    // the next opposing-liquidity pool from the sweep/range (structural), RR floats,
    // and a setup is a no-trade when that structural RR is below rr_floor. The
    // fixed-RR projection is retained only as comparison metadata (tpFixed/rrFixed)
    // for the Outcome Lab A/B — it is no longer the trade target. "fixed_rr" is an
    // opt-in legacy mode for older cron/email jobs that still expect a 2R target.
    target_mode: (() => { const m = str(p.target_mode, "structural_first"); return m === "fixed_rr" ? "fixed_rr" : "structural_first"; })(),
    rr_floor: num(p.rr_floor, 1.5),
    // Funding crowding (req #5): |funding| >= funding_extreme_pct is treated as an
    // extreme/veto rather than a fade signal.
    funding_extreme_pct: num(p.funding_extreme_pct, 0.15),
    // Code-enforced time-stop (req #4): exposed so the UI/Outcome Lab can show it.
    // The actual enforcement lives in tradelog.tripleBarrier (time_stop_bars).
    time_stop_bars: Math.max(1, Math.round(num(p.time_stop_bars, 192))),
    vol_exhaustion: str(p.vol_exhaustion, "context"),
    macd_divergence: str(p.macd_divergence, "context"),
    bb_position: str(p.bb_position, "context"),
    quote_filter: str(p.quote_filter, ""),
    min_turnover: num(p.min_turnover, 0),
    // Honor the requested symbol cap, clamped to [1, 1000] (1000 = full live
    // universe). Default (no field sent) is the full universe via num(...,1000).
    // A low value is a deliberate "scan fewer / go faster" choice and must NOT be
    // silently overridden — the old <=120 -> 1000 rewrite masked real scan scope
    // for any client requesting a small cap and made max_symbols smoke tests
    // meaningless (e.g. {max_symbols:40} returning the full universe).
    max_symbols: Math.max(1, Math.min(1000, Math.round(num(p.max_symbols, 1000)))),
    concurrency: Math.max(1, Math.min(16, Math.round(num(p.concurrency, 8)))),
    max_retries: Math.max(1, Math.min(6, Math.round(num(p.max_retries, 3)))),
    family_score_floor: num(p.family_score_floor, 75),
    cusum_threshold: num(p.cusum_threshold, 1.0),
    strict: p.strict === undefined ? true : !!p.strict,
  };
}

module.exports = {
  DEFAULT_BASE, TESTNET_BASE, GATE_LABELS,
  DeltaPublic, analyze, scan, marketRegime, selectUniverse, formatScan, fmtPrice,
  buildConfig, allTimeframes, structuralTarget,
  classifyFunding, fundingSignalFor, exposureGroup, btcRegimeAlign, betaGate, execStatusBase,
  emaSeries, emaLast, rsiSeries, cusumRegime,
};
