"use strict";
/* ============================================================================
 * alert-scan.js — scheduled CLEAN-setup detector for the email alerter.
 *
 * Reuses the SAME scanner the app uses (no divergence). Runs ONE live scan of
 * Delta India public data, finds setups that pass all four families (corePass)
 * and aren't beta-blocked, and — for any that are NOT on cooldown — writes
 * GitHub Actions outputs (has_setup / subject / body) so the workflow can email.
 *
 * Public Delta data only. SCAN-ONLY: it never places an order, never touches a
 * private account, never handles a credential. The email send happens in the
 * workflow via your own Gmail App Password stored as a GitHub secret.
 *
 * Cooldown: a small JSON state file (persisted between runs via actions/cache)
 * records when each sym|dir was last alerted, so the same setup is not emailed
 * again within ALERT_COOLDOWN_HOURS. Nothing here is financial advice.
 * ========================================================================== */
const fs = require("fs");
const { DeltaPublic, scan, buildConfig, marketRegime, btcRegimeAlign, betaGate } = require("./scanner.js");

const STATE_FILE = process.env.ALERT_STATE_FILE || ".alert-state.json";
const COOLDOWN_HOURS = parseFloat(process.env.ALERT_COOLDOWN_HOURS || "4") || 4;

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {}; } catch (_) { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (_) { /* noop */ } }

// Write a GitHub Actions step output (multiline-safe), or print locally.
function setOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  const v = String(value == null ? "" : value);
  if (f) { fs.appendFileSync(f, `${key}<<__ALERT_EOF__\n${v}\n__ALERT_EOF__\n`); }
  else { console.log(`[output] ${key}=${v.replace(/\n/g, "\\n")}`); }
}

function fmt(v, d) { return (v == null || isNaN(+v)) ? "—" : (+v).toLocaleString("en-US", { maximumFractionDigits: (d == null ? 6 : d) }); }

(async () => {
  try {
    const cfg = buildConfig({});
    const client = new DeltaPublic(cfg);
    const results = await scan(cfg, client);

    let regime;
    try { regime = await marketRegime(client, cfg); } catch (_) { regime = { available: false }; }
    for (const r of results) {
      if (!r || r.err) continue;
      r.btcRegimeAlign = btcRegimeAlign(regime, r.dir);
      r.betaGate = betaGate(regime, r.dir, r.correlatedExposureGroup);
      if (r.betaGate === "block") r.executionStatus = "AVOID";
    }

    // Honest CLEAN set: all four families pass, not beta-blocked. Same ranking
    // the scanner/app uses.
    const clean = results
      .filter(r => r && !r.err && r.corePass && r.executionStatus !== "AVOID")
      .sort((a, b) => (b.familyScore - a.familyScore) || (b.score4 - a.score4));

    const now = Date.now();
    const state = readState();
    for (const k of Object.keys(state)) {
      if (now - state[k] > COOLDOWN_HOURS * 3600 * 1000) delete state[k]; // expire
    }
    const fresh = clean.filter(r => !state[`${r.sym}|${r.dir}`]);

    if (!fresh.length) {
      setOutput("has_setup", "false");
      writeState(state);
      console.log(`No fresh CLEAN setups (clean=${clean.length}, all on cooldown or none).`);
      return;
    }

    for (const r of fresh) state[`${r.sym}|${r.dir}`] = now;
    writeState(state);

    const lines = fresh.map(r =>
      `${r.sym} ${String(r.dir || "").toUpperCase()}  |  4-family ${r.familyScore}/4  |  ` +
      `entry ${fmt(r.entry)}  stop ${fmt(r.stop)}  target ${fmt(r.target)}  R:R ${fmt(r.rr, 2)}  |  ` +
      `${r.executionStatus || ""}${r.btcRegimeAlign ? "  · BTC " + r.btcRegimeAlign : ""}`);

    const subject = `Delta scanner: ${fresh.length} CLEAN setup${fresh.length > 1 ? "s" : ""} (${fresh.map(r => r.sym).join(", ")})`;
    const body = [
      "Delta Scanner — CLEAN four-family setup(s) detected on live Delta India data.",
      "",
      ...lines,
      "",
      "Stops/targets are structural levels from the scan (stop at invalidation, not reverse-engineered to a ratio).",
      "Scan-only — no order was placed. Not financial advice. Verify on Delta before acting.",
      `Detected ${new Date().toISOString()}.`,
    ].join("\n");

    setOutput("has_setup", "true");
    setOutput("subject", subject);
    setOutput("body", body);
    console.log(`Fresh CLEAN setups: ${fresh.length} -> emailing.`);
  } catch (e) {
    // Never fail the workflow on a transient scan/network error — just skip.
    setOutput("has_setup", "false");
    console.error("alert-scan error:", (e && e.message) || e);
    process.exit(0);
  }
})();
