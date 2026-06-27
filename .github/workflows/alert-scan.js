"use strict";
/* ============================================================================
 * alert-scan.js — scheduled CLEAN-setup detector for the email alerter.
 * ========================================================================== */

const fs = require("fs");
const {
  DeltaPublic,
  scan,
  buildConfig,
  marketRegime,
  btcRegimeAlign,
  betaGate,
} = require("./scanner.js");

const STATE_FILE = process.env.ALERT_STATE_FILE || ".alert-state.json";
const COOLDOWN_HOURS = parseFloat(process.env.ALERT_COOLDOWN_HOURS || "4") || 4;

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch (_) {
    /* noop */
  }
}

// Write a GitHub Actions step output (multiline-safe), or print locally.
function setOutput(key, value) {
  const f = process.env.GITHUB_OUTPUT;
  const v = String(value == null ? "" : value);

  if (f) {
    // Multiline output uses a heredoc style marker.
    fs.appendFileSync(
      f,
      `${key}<<__ALERT_EOF__\n${v}\n__ALERT_EOF__\n`
    );
  } else {
    console.log(`[output] ${key}=${v.replace(/\n/g, "\\n")}`);
  }
}

function fmt(v, d) {
  const n = v == null ? NaN : +v;
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    maximumFractionDigits: d == null ? 6 : d,
  });
}

(async () => {
  try {
    const cfg = buildConfig({});
    const client = new DeltaPublic(cfg);

    const results = await scan(cfg, client);

    let regime;
    try {
      regime = await marketRegime(client, cfg);
    } catch (_) {
      regime = { available: false };
    }

    for (const r of results || []) {
      if (!r || r.err) continue;

      r.btcRegimeAlign = btcRegimeAlign(regime, r.dir);
      r.betaGate = betaGate(
        regime,
        r.dir,
        r.correlatedExposureGroup
      );

      if (r.betaGate === "block") r.executionStatus = "AVOID";
    }

    // Honest CLEAN set: all four families pass, not beta-blocked.
    const clean = (results || [])
      .filter(
        (r) =>
          r &&
          !r.err &&
          r.corePass &&
          r.executionStatus !== "AVOID"
      )
      .sort((a, b) => (b.familyScore - a.familyScore) || (b.score4 - a.score4));

    const now = Date.now();
    const state = readState();

    // expire old cooldown keys
    const msCooldown = COOLDOWN_HOURS * 3600 * 1000;
    for (const k of Object.keys(state)) {
      const t = +state[k];
      if (!isFinite(t) || now - t > msCooldown) delete state[k];
    }

    const fresh = clean.filter((r) => {
      const sym = r && r.sym;
      const dir = r && r.dir;
      if (!sym) return false;
      const key = `${sym}|${dir}`;
      return !state[key];
    });

    if (!fresh.length) {
      setOutput("has_setup", "false");
      writeState(state);
      console.log(`No fresh CLEAN setups (clean=${clean.length}, all on cooldown or none).`);
      return;
    }

    // mark cooldown
    for (const r of fresh) {
      const key = `${r.sym}|${r.dir}`;
      state[key] = now;
    }
    writeState(state);

    const lines = fresh.map((r) => {
      const dirUpper = String(r.dir || "").toUpperCase();
      return (
        `${r.sym} ${dirUpper}  |  4-family ${r.familyScore}/4  |  ` +
        `entry ${fmt(r.entry)}  stop ${fmt(r.stop)}  target ${fmt(r.target)}  ` +
        `R:R ${fmt(r.rr, 2)}  |  ` +
        `${r.executionStatus || ""}` +
        `${r.btcRegimeAlign ? "  · BTC " + r.btcRegimeAlign : ""}`
      );
    });

    const subject = `Delta scanner: ${fresh.length} CLEAN setup${fresh.length > 1 ? "s" : ""} (${fresh.map((r) => r.sym).join(", ")})`;

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
    // Never fail the workflow on transient scan/network error — just skip.
    setOutput("has_setup", "false");
    console.error("alert-scan error:", (e && e.message) || e);
    process.exit(0);
  }
})();
