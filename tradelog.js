/* tradelog.js — outcome log + triple-barrier labeler for Delta Scanner v4.
 *
 * PURE DATA. No orders, no private account access, no secrets. This module only
 * records the setups the scanner already surfaced and, later, resolves each one
 * against public OHLC candles using a triple-barrier rule (stop / target /
 * time-stop). It produces an honest expectancy read so the operator can judge
 * whether structural targets beat a naive fixed-2R exit — measured, not guessed.
 *
 * Storage: an append-only JSONL event log (default data/tradelog.jsonl). Each
 * line is one event: an OPEN (a surfaced setup) or a CLOSE (its resolution).
 * Logical records are reconciled by id, so history is never edited in place.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "data", "tradelog.jsonl");

const DEFAULTS = {
  taker_fee_pct: 0.05, // taker fee per side, % of notional (Delta ~0.05%)
  slippage_pct: 0.02,  // assumed slippage per side, % of price
  fixed_rr: 2,         // the naive benchmark target = entry ± fixed_rr * risk
  resolve_tf: "15m",   // candle resolution used to resolve open setups
  resolve_bars: 480,   // how many candles to pull when resolving (~5d of 15m)
  time_stop_bars: 192, // bars before a setup is force-closed at market (~2d/15m)
  min_n: 120,          // resolved-trade floor before expectancy is "verdict ready"
                       // (req #1: ~100-150 trades before any verdict is presented)
};

// Honest 4-family labels, fixed order matching scanner's familyList.
const FAMILY_LABELS = ["direction", "structure", "funding", "execution"];

/* --------------------------------------------------------------------------
 * Low-level JSONL helpers (sync; the log is tiny and access is infrequent).
 * ------------------------------------------------------------------------ */
function ensureDir(file) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
}

function readEvents(file) {
  const f = file || DEFAULT_FILE;
  let raw;
  try { raw = fs.readFileSync(f, "utf8"); }
  catch (e) { return []; } // missing file = empty log
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* skip corrupt line */ }
  }
  return out;
}

function appendEvent(rec, file) {
  const f = file || DEFAULT_FILE;
  ensureDir(f);
  fs.appendFileSync(f, JSON.stringify(rec) + "\n", "utf8");
}

// Coerce to a finite number or null. Guards the classic `+null === 0` trap:
// a nullable field like tpStruct must stay null, never silently become 0.
function numOrNull(x) {
  if (x == null) return null;
  const n = +x;
  return Number.isFinite(n) ? n : null;
}

// Round a price to a stable string so the same plan yields the same id.
function rnd(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "x";
  const abs = Math.abs(n);
  const dp = abs >= 100 ? 2 : abs >= 1 ? 4 : 8;
  return n.toFixed(dp);
}

// Deterministic, idempotent id for a surfaced setup. Includes the UTC day so a
// genuinely new plan on a later day re-logs, but the same plan surfaced many
// times in one day collapses to a single OPEN record.
function setupId(r) {
  const day = new Date().toISOString().slice(0, 10);
  return [String(r.sym || r.symbol || "?").toUpperCase(),
    String(r.dir || r.side || "?").toLowerCase(),
    rnd(r.entry), rnd(r.stop), rnd(r.target), day].join("|");
}

/* --------------------------------------------------------------------------
 * Reconcile the append-only event stream into logical records keyed by id.
 * First OPEN wins; the first matching CLOSE flips it to CLOSED.
 * ------------------------------------------------------------------------ */
function reconcile(file) {
  const events = readEvents(file);
  const map = new Map();
  for (const e of events) {
    if (!e || !e.id) continue;
    if (e.type === "OPEN") {
      if (!map.has(e.id)) map.set(e.id, Object.assign({}, e, { status: "OPEN" }));
    } else if (e.type === "CLOSE") {
      const o = map.get(e.id);
      if (o && o.status === "OPEN") {
        o.status = "CLOSED";
        o.outcome = e.outcome;
        o.exit = e.exit;
        o.bars = e.bars;
        o.R = e.R;
        o.fixedOutcome = e.fixedOutcome;
        o.fixedR = e.fixedR;
        o.tradedOutcome = e.tradedOutcome != null ? e.tradedOutcome : e.fixedOutcome;
        o.tradedR = e.tradedR != null ? e.tradedR : e.fixedR;
        o.closed_ts = e.ts;
      }
    }
  }
  return Array.from(map.values());
}

/* --------------------------------------------------------------------------
 * logSetup(analyzed, cfg, file)
 * Idempotently append OPEN events for the strict surfaced setups. Accepts an
 * array of analyzed rows, or an object with .passed / .setups / .results.
 * Returns { logged, skipped, candidates, total }.
 * ------------------------------------------------------------------------ */
function logSetup(analyzed, cfg, file) {
  const f = file || DEFAULT_FILE;
  let rows = analyzed;
  if (rows && !Array.isArray(rows)) rows = rows.passed || rows.setups || rows.results || [];
  rows = Array.isArray(rows) ? rows : [];

  // Only log genuine, tradeable setups with a valid R structure. Honest CLEAN
  // (corePass) is the primary trigger now; legacy strict 8/8 still qualifies.
  const candidates = rows.filter(r =>
    r && (r.corePass === true || r.passed === true || r.score8 === 8) &&
    (r.dir || r.side) &&
    Number.isFinite(+r.entry) && Number.isFinite(+r.stop) && Number.isFinite(+r.target) &&
    +r.entry !== +r.stop);

  const existing = new Set(readEvents(f).filter(e => e && e.type === "OPEN").map(e => e.id));
  const entryTf = (cfg && cfg.entry_tf) || DEFAULTS.resolve_tf;
  let logged = 0, skipped = 0;
  for (const r of candidates) {
    const id = setupId(r);
    if (existing.has(id)) { skipped++; continue; }
    existing.add(id);
    appendEvent({
      type: "OPEN",
      id,
      ts: new Date().toISOString(),
      sym: String(r.sym || r.symbol).toUpperCase(),
      side: String(r.dir || r.side).toLowerCase(),
      entry: +r.entry,
      stop: +r.stop,
      target: +r.target,
      // Structural counterfactual target/RR. numOrNull keeps a missing structural
      // target as null (a unary + would turn null into a bogus 0 price).
      tpStruct: numOrNull(r.tpStruct),
      rrStruct: numOrNull(r.rrStruct),
      // Fixed-RR projection retained as comparison metadata for the A/B. The
      // actually-traded plan is `target` (which equals tpFixed in fixed_rr mode
      // and equals tpStruct in structural_first mode).
      tpFixed: numOrNull(r.tpFixed),
      rrFixed: numOrNull(r.rrFixed),
      targetMode: r.targetMode || "structural_first",
      // Honest 4-family rollup so expectancy can break down per family (req #1/#2).
      familyList: Array.isArray(r.familyList) ? r.familyList.map(Boolean) : null,
      familyScore: Number.isFinite(+r.familyScore) ? +r.familyScore : null,
      corePass: r.corePass === true,
      honestVerdict: r.honestVerdict || null,
      // Crowding + beta context for alpha testing (req #5/#6).
      fundingState: r.fundingState || null,
      fundingSignal: r.fundingSignal || null,
      correlatedExposureGroup: r.correlatedExposureGroup || null,
      btcRegimeAlign: r.btcRegimeAlign || null,
      judasMode: r.judasMode || null,
      score8: Number.isFinite(+r.score8) ? +r.score8 : null,
      score4: Number.isFinite(+r.score4) ? +r.score4 : null,
      rr: Number.isFinite(+r.rr) ? +r.rr : null,
      validityStatus: r.validityStatus || null,
      biasSide: r.biasSide || null,
      formation: r.formation || null,
      entry_tf: entryTf,
    }, f);
    logged++;
  }
  return { logged, skipped, candidates: candidates.length, total: rows.length };
}

/* --------------------------------------------------------------------------
 * tripleBarrier(side, entry, stop, target, candles, opt)
 * Resolve a single plan against chronological, post-entry candles.
 *   - SL / TP whichever the price touches first.
 *   - If both are touched within the SAME candle, tie-break PESSIMISTICALLY
 *     (assume the stop filled first) — never flatter than reality.
 *   - If neither resolves within time_stop_bars, TIME-stop at that candle close.
 * Round-trip taker fee + slippage are subtracted, expressed in R.
 * Returns { outcome: "TP"|"SL"|"TIME"|"NONE", exit, bars, R, grossR, feeR }.
 * ------------------------------------------------------------------------ */
function tripleBarrier(side, entry, stop, target, candles, opt) {
  const o = Object.assign({}, DEFAULTS, opt || {});
  const long = String(side).toLowerCase() === "long";
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !Array.isArray(candles) || !candles.length) {
    return { outcome: "NONE", exit: null, bars: 0, R: null, grossR: null, feeR: null };
  }
  const maxBars = Math.min(candles.length, o.time_stop_bars);
  // Round-trip cost in price terms, then converted to R.
  const costPrice = entry * (o.taker_fee_pct / 100 + o.slippage_pct / 100) * 2;
  const feeR = costPrice / risk;

  let outcome = "TIME", exit = candles[maxBars - 1].c, bars = maxBars;
  for (let i = 0; i < maxBars; i++) {
    const k = candles[i];
    const hitSL = long ? k.l <= stop : k.h >= stop;
    const hitTP = long ? k.h >= target : k.l <= target;
    if (hitSL && hitTP) { outcome = "SL"; exit = stop; bars = i + 1; break; } // pessimistic
    if (hitSL) { outcome = "SL"; exit = stop; bars = i + 1; break; }
    if (hitTP) { outcome = "TP"; exit = target; bars = i + 1; break; }
  }
  const grossR = (long ? (exit - entry) : (entry - exit)) / risk;
  const R = grossR - feeR;
  return { outcome, exit, bars, R, grossR, feeR };
}

/* --------------------------------------------------------------------------
 * resolveOpen(client, cfg, file)
 * Resolve every OPEN record using public candles from the scanner's client
 * (client.candles(symbol, tf, bars)). Appends a CLOSE event when a setup
 * resolves (SL/TP) or hits its time-stop. Pure data — never places orders.
 * Returns { checked, resolved, stillOpen, errors }.
 * ------------------------------------------------------------------------ */
async function resolveOpen(client, cfg, file) {
  const f = file || DEFAULT_FILE;
  const opt = Object.assign({}, DEFAULTS, {
    taker_fee_pct: cfg && cfg.taker_fee_pct,
    slippage_pct: cfg && cfg.slippage_pct,
    fixed_rr: (cfg && (cfg.rr_target || cfg.fixed_rr)) || DEFAULTS.fixed_rr,
  });
  // Strip undefined overrides so DEFAULTS win.
  Object.keys(opt).forEach(k => { if (opt[k] == null) opt[k] = DEFAULTS[k]; });

  const records = reconcile(f);
  const open = records.filter(r => r.status === "OPEN");
  let resolved = 0, errors = 0, checked = 0;

  for (const rec of open) {
    checked++;
    const tf = RES_OK(rec.entry_tf) ? rec.entry_tf : opt.resolve_tf;
    let candles = null;
    try { candles = await client.candles(rec.sym, tf, opt.resolve_bars); }
    catch (e) { errors++; continue; }
    if (!candles || !candles.length) { errors++; continue; }

    // Only consider candles that occurred AFTER the setup was logged.
    const sinceSec = Math.floor(new Date(rec.ts).getTime() / 1000);
    const post = candles.filter(c => c.t > sinceSec);
    if (!post.length) continue; // not enough forward data yet — leave open

    const risk = Math.abs(rec.entry - rec.stop);
    if (!(risk > 0)) { errors++; continue; }

    // FIXED counterfactual: always resolved against the fixed-RR projection
    // (tpFixed), falling back to rec.target only for legacy records logged before
    // tpFixed existed. This is the "fixed" leg of the A/B — never a proxy.
    const tpFixed = numOrNull(rec.tpFixed);
    const fixedTarget = tpFixed != null ? tpFixed : rec.target;
    const fixed = tripleBarrier(rec.side, rec.entry, rec.stop, fixedTarget, post, opt);

    // STRUCTURAL counterfactual: measurable ONLY when a structural target was
    // recorded. When absent it stays null — never resolved against the fixed
    // target — so the A/B compares real structural exits, not a duplicate.
    const tpStruct = numOrNull(rec.tpStruct);
    const structural = tpStruct != null
      ? tripleBarrier(rec.side, rec.entry, rec.stop, tpStruct, post, opt)
      : { outcome: null, exit: null, bars: null, R: null };

    // The ACTUALLY-TRADED plan is rec.target (== tpFixed in fixed_rr mode, ==
    // tpStruct in structural_first mode). It GATES closure so a record closes
    // when its real plan resolves — regardless of which leg is primary.
    const traded = tripleBarrier(rec.side, rec.entry, rec.stop, rec.target, post, opt);
    const isResolved = traded.outcome === "TP" || traded.outcome === "SL" ||
      (traded.outcome === "TIME" && post.length >= opt.time_stop_bars);
    if (!isResolved) continue;

    appendEvent({
      type: "CLOSE",
      id: rec.id,
      ts: new Date().toISOString(),
      outcome: structural.outcome,   // structural counterfactual (null when none)
      exit: structural.exit,
      bars: structural.bars,
      R: round4(structural.R),       // structural R (null when no structural target)
      fixedOutcome: fixed.outcome,   // fixed-RR counterfactual
      fixedR: round4(fixed.R),
      tradedOutcome: traded.outcome, // the plan that actually gated closure
      tradedR: round4(traded.R),
    }, f);
    resolved++;
  }
  return { checked, resolved, stillOpen: open.length - resolved, errors };
}

const RES_SET = new Set(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "1d"]);
function RES_OK(tf) { return RES_SET.has(tf); }
function round4(x) { return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null; }

/* --------------------------------------------------------------------------
 * expectancy(opt, file)
 * Honest, measured expectancy over CLOSED records. Below min_n closed trades
 * the numbers are returned but flagged provisional (verdict_ready=false) so the
 * UI never presents a premature verdict.
 * ------------------------------------------------------------------------ */
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

function summarize(closed) {
  const sR = closed.map(r => r.R).filter(Number.isFinite);
  const fR = closed.map(r => r.fixedR).filter(Number.isFinite);
  // structural_minus_fixed must be measured on PAIRED records only — those where
  // BOTH a structural R and a fixed R exist — otherwise the difference of two
  // means over different samples is meaningless.
  const pairedDiffs = closed
    .filter(r => Number.isFinite(r.R) && Number.isFinite(r.fixedR))
    .map(r => r.R - r.fixedR);
  // Win rate reflects the ACTUAL traded (fixed) plan, not the structural
  // counterfactual. The fixed plan always resolves for a closed record.
  const fWins = closed.filter(r => Number.isFinite(r.fixedR) && r.fixedR > 0).length;
  const fN = fR.length;
  const sExp = mean(sR), fExp = mean(fR), dExp = mean(pairedDiffs);
  return {
    n: closed.length,
    structural_expectancy_R: sExp == null ? null : round4(sExp),
    fixed_expectancy_R: fExp == null ? null : round4(fExp),
    structural_minus_fixed_R: dExp == null ? null : round4(dExp),
    paired_n: pairedDiffs.length,
    win_rate: fN ? round4(fWins / fN) : null,
  };
}

function expectancy(opt, file) {
  const o = Object.assign({}, DEFAULTS, opt || {});
  const records = reconcile(file);
  const closed = records.filter(r => r.status === "CLOSED");
  const openN = records.filter(r => r.status === "OPEN").length;
  const minN = o.min_n;
  const verdict_ready = closed.length >= minN;

  const overall = summarize(closed);
  const bySide = {
    long: summarize(closed.filter(r => r.side === "long")),
    short: summarize(closed.filter(r => r.side === "short")),
  };
  const byScore = {};
  for (const r of closed) {
    const key = String(r.score8 != null ? r.score8 : "na");
    (byScore[key] = byScore[key] || []).push(r);
  }
  Object.keys(byScore).forEach(k => { byScore[k] = summarize(byScore[k]); });

  // Per-family expectancy (req #1/#2): expectancy over the resolved trades in
  // which each honest family passed, so the operator can see which families
  // actually carry edge instead of trusting 8 correlated gate counts.
  const byFamily = {};
  FAMILY_LABELS.forEach((label, i) => {
    const subset = closed.filter(r => Array.isArray(r.familyList) && r.familyList[i]);
    byFamily[label] = summarize(subset);
  });

  // Group expectancy by the independent SIGNALS (req #5/#6), not the gate count:
  // funding crowding state and correlated-exposure group. This is how the data
  // tells the operator which signals actually carry edge.
  const groupBy = (keyFn) => {
    const m = {};
    for (const r of closed) {
      const k = keyFn(r);
      if (k == null) continue;
      (m[k] = m[k] || []).push(r);
    }
    Object.keys(m).forEach(k => { m[k] = summarize(m[k]); });
    return m;
  };
  const byFundingState = groupBy(r => r.fundingState || null);
  const byFundingSignal = groupBy(r => r.fundingSignal || null);
  const byGroup = groupBy(r => r.correlatedExposureGroup || null);

  const note = verdict_ready
    ? "Verdict ready — based on the resolved-trade sample below."
    : `Provisional — ${closed.length}/${minN} resolved trades. Outcome stats firm up once N reaches ${minN}.`;

  return {
    file: file || DEFAULT_FILE,
    total: records.length,
    open: openN,
    closed: closed.length,
    min_n: minN,
    verdict_ready,
    note,
    structural_expectancy_R: overall.structural_expectancy_R,
    fixed_expectancy_R: overall.fixed_expectancy_R,
    structural_minus_fixed_R: overall.structural_minus_fixed_R,
    win_rate: verdict_ready ? overall.win_rate : null, // suppress until ready
    win_rate_provisional: overall.win_rate,
    paired_n: overall.paired_n,
    by_side: bySide,
    by_score: byScore,
    by_family: byFamily,
    by_funding_state: byFundingState,
    by_funding_signal: byFundingSignal,
    by_group: byGroup,
    not_financial_advice: true,
    generated_at: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------------------
 * recent(limit, file) — reconciled logical records, newest first.
 * ------------------------------------------------------------------------ */
function recent(limit, file) {
  const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
  const records = reconcile(file);
  records.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return records.slice(0, n);
}

module.exports = {
  DEFAULT_FILE, DEFAULTS,
  logSetup, tripleBarrier, resolveOpen, expectancy, recent,
  reconcile, setupId, readEvents,
};
