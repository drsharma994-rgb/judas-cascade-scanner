"use strict";
/* ============================================================================
 * factorlab.js — honest factor evaluation with multiple-testing correction.
 *
 * This is the disciplined version of "mine 50 factors, keep Sharpe > 2". The
 * trap in that prompt is selection bias: try enough random expressions and some
 * WILL backtest above 2 from noise alone. This module corrects for exactly that
 * using the Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014): it asks
 * whether a factor's Sharpe survives AFTER accounting for (a) how many factors
 * you tried, (b) non-normal returns (skew/kurtosis), (c) sample length — and it
 * judges on a WALK-FORWARD out-of-sample segment, net of Delta fees.
 *
 * PURE ANALYSIS: no network, no orders, no live sizing. It reuses the project's
 * convention that nothing is trusted until measured out-of-sample.
 *
 * Deliberately EXCLUDED inputs (not available on Delta India public data, so a
 * factor built on them would be untestable here and dishonest to ship):
 *   - order-book imbalance  -> needs L2 depth (not pulled)
 *   - taker/aggressor flow  -> needs /v2/trades (does not exist; placeholder)
 * Funding-based factors are only valid from 2026-06-12 forward (pre-12 funding
 * fields are null/invalid); the caller must clean those rows before evaluation.
 * Nothing here is financial advice or a guarantee.
 * ========================================================================== */

const EULER_MASCHERONI = 0.5772156649015329;

/* ---------- basic moments ---------- */
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN; }
function std(a) { // sample std (n-1)
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
function skewness(a) {
  const n = a.length; if (n < 3) return 0;
  const m = mean(a), s = std(a); if (!(s > 0)) return 0;
  return a.reduce((acc, x) => acc + Math.pow((x - m) / s, 3), 0) / n;
}
function kurtosisRaw(a) { // raw (normal = 3), NOT excess
  const n = a.length; if (n < 4) return 3;
  const m = mean(a), s = std(a); if (!(s > 0)) return 3;
  return a.reduce((acc, x) => acc + Math.pow((x - m) / s, 4), 0) / n;
}

/* ---------- normal CDF / inverse (Acklam) ---------- */
function normCdf(x) { // Abramowitz-Stegun 7.1.26, |err| < 1.5e-7
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  let p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function normInv(p) { // Acklam's inverse normal CDF
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0,
    3.754408661907416e0];
  const pl = 0.02425, ph = 1 - pl; let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
           ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p <= ph) { q = p - 0.5; r = q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
           (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
          ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

/* ---------- Sharpe + Probabilistic Sharpe ---------- */
// Per-period Sharpe (no risk-free; returns are already excess/PnL units).
function sharpe(returns) {
  const s = std(returns);
  return s > 0 ? mean(returns) / s : NaN;
}
// PSR: P(true SR > srBenchmark) given observed SR, skew, kurtosis, n.
// srObserved and srBenchmark must be in the SAME (per-period) units.
function probabilisticSharpe(returns, srBenchmark) {
  const n = returns.length;
  if (n < 4) return NaN;
  const sr = sharpe(returns);
  if (!Number.isFinite(sr)) return NaN;
  const g1 = skewness(returns), g2 = kurtosisRaw(returns);
  const denom = Math.sqrt(Math.max(1e-12, 1 - g1 * sr + ((g2 - 1) / 4) * sr * sr));
  return normCdf(((sr - srBenchmark) * Math.sqrt(n - 1)) / denom);
}

// Expected MAXIMUM Sharpe under the null of zero true edge, given you ran
// nTrials independent strategies whose estimated Sharpes have variance srVar.
// This is the benchmark a real factor must beat. (Bailey & Lopez de Prado.)
function expectedMaxSharpe(srVar, nTrials) {
  if (!(nTrials > 1) || !(srVar > 0)) return 0;
  const sd = Math.sqrt(srVar);
  return sd * ((1 - EULER_MASCHERONI) * normInv(1 - 1 / nTrials) +
    EULER_MASCHERONI * normInv(1 - 1 / (nTrials * Math.E)));
}

/* ---------- fee-aware net returns ---------- */
// Turnover-aware: a position only earns the next-bar return, and any CHANGE in
// signal pays round-trip cost proportional to the size of the change. This is
// where naive factor backtests lie — they ignore that flipping costs fees.
function netReturns(signals, fwdReturns, opt) {
  const o = opt || {};
  const feeBps = Number.isFinite(o.fee_bps) ? o.fee_bps : 5;   // Delta taker ~ per side
  const slipBps = Number.isFinite(o.slip_bps) ? o.slip_bps : 2;
  const costPerUnitTurnover = (feeBps + slipBps) / 1e4;
  const out = [];
  let prev = 0;
  const n = Math.min(signals.length, fwdReturns.length);
  for (let i = 0; i < n; i++) {
    const sig = clamp(signals[i], -1, 1);
    const gross = sig * fwdReturns[i];
    const turnover = Math.abs(sig - prev);
    out.push(gross - turnover * costPerUnitTurnover);
    prev = sig;
  }
  return out;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0)); }

/* ---------- pre-specified factor set (SMALL, economically motivated) ----------
 * Each factor maps a feature row -> signal in [-1, 1]. No fitted parameters, so
 * the out-of-sample segment is a clean holdout (no leakage). Rows must carry the
 * referenced fields; missing fields yield a flat (0) signal for that bar, never
 * a fabricated value. Add factors sparingly — every extra factor RAISES the
 * Deflated-Sharpe bar the survivors must clear.
 * ------------------------------------------------------------------------ */
const FACTORS = {
  // Crowded-funding fade: extreme funding means one side is paying to hold; fade
  // it. Sign is opposite the funding sign, scaled by how extreme it is.
  funding_fade(r) {
    if (!Number.isFinite(r.fundingZ)) return 0;
    return clamp(-r.fundingZ / 2, -1, 1);
  },
  // RSI mean-reversion: fade stretched RSI toward 50.
  rsi_reversion(r) {
    if (!Number.isFinite(r.rsi)) return 0;
    return clamp(-(r.rsi - 50) / 30, -1, 1);
  },
  // EMA cascade momentum: go with fast-vs-slow EMA alignment.
  ema_cascade(r) {
    if (!Number.isFinite(r.emaFast) || !Number.isFinite(r.emaSlow) || !(r.emaSlow > 0)) return 0;
    return clamp(((r.emaFast - r.emaSlow) / r.emaSlow) * 50, -1, 1);
  },
  // CUSUM directional break: +1 up-break, -1 down-break, 0 none.
  cusum_break(r) {
    if (r.cusumDir === "UP") return 1;
    if (r.cusumDir === "DOWN") return -1;
    return 0;
  },
};

/* ---------- evaluation ----------
 * rows: chronological array of feature rows; each must include `fwdRet` (the
 *       realized forward return of the bar AFTER the features were observed, so
 *       there is no look-ahead).
 * factors: map name -> fn(row) (defaults to FACTORS).
 * Returns per-factor in/out-of-sample Sharpe, PSR, and the DEFLATED Sharpe that
 * accounts for the number of factors tried. A factor "survives" only if its
 * OOS Deflated Sharpe clears the threshold (default 0.95 = 95% confidence the
 * true Sharpe beats the multiple-testing benchmark).
 * ------------------------------------------------------------------------ */
function evaluateFactors(rows, factors, opt) {
  const o = opt || {};
  const facs = factors || FACTORS;
  const names = Object.keys(facs);
  const trainFrac = Number.isFinite(o.train_frac) ? o.train_frac : 0.6;
  const dsrThreshold = Number.isFinite(o.dsr_threshold) ? o.dsr_threshold : 0.95;
  const periodsPerYear = Number.isFinite(o.periods_per_year) ? o.periods_per_year : null;

  const clean = rows.filter(r => r && Number.isFinite(r.fwdRet));
  const split = Math.max(2, Math.floor(clean.length * trainFrac));
  const trainRows = clean.slice(0, split);
  const testRows = clean.slice(split);

  const legPerFactor = (rs) => {
    const fwd = rs.map(r => r.fwdRet);
    return (fn) => netReturns(rs.map(fn), fwd, o);
  };
  const trainLeg = legPerFactor(trainRows);
  const testLeg = legPerFactor(testRows);

  // First pass: per-factor OOS Sharpe (per-period) so we can measure the
  // variance of trial Sharpes that the deflation needs.
  const oosReturns = {}, isReturns = {}, oosSharpe = {};
  for (const name of names) {
    oosReturns[name] = testLeg(facs[name]);
    isReturns[name] = trainLeg(facs[name]);
    oosSharpe[name] = sharpe(oosReturns[name]);
  }
  const validSharpes = names.map(n => oosSharpe[n]).filter(Number.isFinite);
  // Only factors that actually traded (finite OOS Sharpe) count as trials. An
  // unwired factor (e.g. funding before its feed exists) emits a flat 0 signal,
  // never trades, and must NOT inflate the multiple-testing bar for the others.
  const activeNames = names.filter(n => Number.isFinite(oosSharpe[n]));
  const inactiveNames = names.filter(n => !Number.isFinite(oosSharpe[n]));
  const srVar = validSharpes.length > 1 ? variancePop(validSharpes) : 0;
  const nTrials = activeNames.length;
  const sr0 = expectedMaxSharpe(srVar, nTrials); // per-period benchmark

  const results = names.map(name => {
    const rOos = oosReturns[name], rIs = isReturns[name];
    const srOos = oosSharpe[name];
    const srIs = sharpe(rIs);
    const ann = periodsPerYear && Number.isFinite(srOos) ? srOos * Math.sqrt(periodsPerYear) : null;
    const dsr = probabilisticSharpe(rOos, sr0);   // deflated: benchmarked vs expected-max
    const psr0 = probabilisticSharpe(rOos, 0);    // undeflated: vs zero (for contrast)
    return {
      factor: name,
      n_oos: rOos.length,
      sharpe_is_perperiod: round4(srIs),
      sharpe_oos_perperiod: round4(srOos),
      sharpe_oos_annualized: ann == null ? null : round4(ann),
      mean_oos_return: round4(mean(rOos)),
      skew_oos: round4(skewness(rOos)),
      kurtosis_oos: round4(kurtosisRaw(rOos)),
      psr_vs_zero: round4(psr0),
      deflated_sharpe: round4(dsr),
      survives: Number.isFinite(dsr) && dsr >= dsrThreshold,
    };
  });
  results.sort((a, b) => (b.deflated_sharpe || -1) - (a.deflated_sharpe || -1));

  return {
    n_total: clean.length,
    n_train: trainRows.length,
    n_test: testRows.length,
    n_factors_tried: nTrials,
    inactive_factors: inactiveNames,
    expected_max_sharpe_null_perperiod: round4(sr0),
    trial_sharpe_variance: round4(srVar),
    dsr_threshold: dsrThreshold,
    fee_bps: Number.isFinite(o.fee_bps) ? o.fee_bps : 5,
    slip_bps: Number.isFinite(o.slip_bps) ? o.slip_bps : 2,
    results,
    survivors: results.filter(r => r.survives).map(r => r.factor),
    note: "Out-of-sample, fee-netted, deflated for the number of factors tried. " +
      "A high raw Sharpe with a low deflated_sharpe is selection-bias noise, not edge. " +
      "Not financial advice.",
    generated_at: new Date().toISOString(),
  };
}

function variancePop(a) { // population variance of trial Sharpes
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length;
}
function round4(x) { return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null; }

/* ---------- shared building block for single-symbol AND sweep ----------
 * Split rows train/test and return each factor's IS/OOS fee-netted returns.
 * Same FACTORS, same netReturns, same split as evaluateFactors — so a sweep
 * nets returns identically to a single run (no divergence).
 * ------------------------------------------------------------------------ */
function oosFactorReturns(rows, factors, opt) {
  const o = opt || {};
  const facs = factors || FACTORS;
  const trainFrac = Number.isFinite(o.train_frac) ? o.train_frac : 0.6;
  const clean = (rows || []).filter(r => r && Number.isFinite(r.fwdRet));
  const split = Math.max(2, Math.floor(clean.length * trainFrac));
  const trainRows = clean.slice(0, split);
  const testRows = clean.slice(split);
  const leg = (rs) => { const fwd = rs.map(r => r.fwdRet); return (fn) => netReturns(rs.map(fn), fwd, o); };
  const trainLeg = leg(trainRows), testLeg = leg(testRows);
  const perFactor = {};
  for (const name of Object.keys(facs)) perFactor[name] = { is: trainLeg(facs[name]), oos: testLeg(facs[name]) };
  return { perFactor, n_total: clean.length, n_train: trainRows.length, n_test: testRows.length };
}

/* ---------- pooled sweep evaluation ----------
 * Deflate every (symbol x timeframe x factor) cell against the expected-max
 * Sharpe of the WHOLE sweep, not each single run. Sweeping is itself multiple
 * testing; pooling is what stops a wide sweep from manufacturing false
 * survivors. cells: [{ key, symbol, resolution, factor, is, oos }].
 * ------------------------------------------------------------------------ */
function evaluatePooled(cells, opt) {
  const o = opt || {};
  const dsrThreshold = Number.isFinite(o.dsr_threshold) ? o.dsr_threshold : 0.95;
  const enriched = (cells || []).map(c => Object.assign({}, c, { srOos: sharpe(c.oos || []) }));
  const active = enriched.filter(c => Number.isFinite(c.srOos));
  const sharpes = active.map(c => c.srOos);
  const srVar = sharpes.length > 1 ? variancePop(sharpes) : 0;
  const nTrials = active.length;
  const sr0 = expectedMaxSharpe(srVar, nTrials);
  const results = enriched.map(c => {
    const rOos = c.oos || [];
    const dsr = probabilisticSharpe(rOos, sr0);
    return {
      key: c.key, symbol: c.symbol, resolution: c.resolution, factor: c.factor,
      n_oos: rOos.length,
      sharpe_is_perperiod: round4(sharpe(c.is || [])),
      sharpe_oos_perperiod: round4(c.srOos),
      psr_vs_zero: round4(probabilisticSharpe(rOos, 0)),
      deflated_sharpe: round4(dsr),
      survives: Number.isFinite(dsr) && dsr >= dsrThreshold,
      active: Number.isFinite(c.srOos),
    };
  });
  results.sort((a, b) => (b.deflated_sharpe || -1) - (a.deflated_sharpe || -1));
  return {
    n_cells: enriched.length,
    n_active_trials: nTrials,
    n_inactive: enriched.length - nTrials,
    expected_max_sharpe_null_perperiod: round4(sr0),
    trial_sharpe_variance: round4(srVar),
    dsr_threshold: dsrThreshold,
    results,
    survivors: results.filter(r => r.survives).map(r => r.key),
    note: "Pooled across the whole sweep: the deflated-Sharpe bar accounts for EVERY " +
      "symbol x timeframe x factor cell tried, so a wide sweep cannot manufacture survivors. " +
      "Out-of-sample, fee-netted. Not financial advice.",
    generated_at: new Date().toISOString(),
  };
}

/* ---------- candle -> feature rows adapter ----------
 * PURE: takes raw candles ({t,o,h,l,c,v}[], ascending) plus the project's OWN
 * indicator functions injected as `deps` ({ emaSeries, rsiSeries, cusumRegime }),
 * so there is NO duplicated/divergent signal logic and NO network here. Produces
 * the feature rows evaluateFactors expects, each tagged with the NEXT bar's
 * realized return (fwdRet) — strictly no look-ahead: row i's features use only
 * closes[0..i], and fwdRet is the move from i to i+1.
 *
 * fundingZ is left null until a funding feed is wired (FUNDING:-prefixed candles,
 * valid 2026-06-12+). With it null, the funding_fade factor stays flat/inactive
 * rather than trading on a fabricated value.
 * ------------------------------------------------------------------------ */
function buildFeatureRows(candles, deps, opt) {
  const o = opt || {};
  const fast = Number.isFinite(o.ema_fast) ? o.ema_fast : 20;
  const slow = Number.isFinite(o.ema_slow) ? o.ema_slow : 50;
  const rsiP = Number.isFinite(o.rsi_period) ? o.rsi_period : 14;
  const cusumWin = Number.isFinite(o.cusum_window) ? o.cusum_window : 60;
  const cusumThr = Number.isFinite(o.cusum_threshold) ? o.cusum_threshold : 1.0;
  if (!Array.isArray(candles) || candles.length < Math.max(slow, rsiP + 1) + 2) return [];
  const closes = candles.map(c => c.c);
  const emaF = (deps.emaSeries && deps.emaSeries(closes, fast)) || [];
  const emaS = (deps.emaSeries && deps.emaSeries(closes, slow)) || [];
  const rsiArr = (deps.rsiSeries && deps.rsiSeries(closes, rsiP)) || [];
  const rows = [];
  for (let i = 0; i < closes.length - 1; i++) { // -1: need a forward bar
    const rsi = rsiArr[i], ef = emaF[i], es = emaS[i];
    if (!Number.isFinite(rsi) || !Number.isFinite(ef) || !Number.isFinite(es)) continue;
    const fwdRet = closes[i] > 0 ? (closes[i + 1] - closes[i]) / closes[i] : NaN;
    if (!Number.isFinite(fwdRet)) continue;
    // CUSUM on the TRAILING window only — never the full series (that would leak
    // future returns into an earlier bar's regime read).
    let cusumDir = "FLAT";
    if (deps.cusumRegime) {
      const win = closes.slice(Math.max(0, i - cusumWin + 1), i + 1);
      const cr = deps.cusumRegime(win, cusumThr);
      cusumDir = Array.isArray(cr) ? cr[0] : "FLAT";
    }
    rows.push({ t: candles[i].t, rsi, emaFast: ef, emaSlow: es, cusumDir, fundingZ: null, fwdRet });
  }
  return rows;
}

module.exports = {
  // stats core
  mean, std, skewness, kurtosisRaw, normCdf, normInv,
  sharpe, probabilisticSharpe, expectedMaxSharpe,
  // factor evaluation
  netReturns, evaluateFactors, buildFeatureRows, oosFactorReturns, evaluatePooled, FACTORS,
};
