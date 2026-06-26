/* server.js — Express backend for Delta Scanner v4 / Judas Cascade.
 * Serves the static PWA AND exposes:
 *   GET  /api/health   -> liveness + Delta reachability + metadata
 *   POST /api/scan     -> live Delta India public-data 8-gate scan
 *
 * SAFETY: scanning uses ONLY public Delta endpoints (no auth, no secrets).
 * This server NEVER places orders. Live execution must run separately via
 * delta-macd-bot/judas_8gate_bot.py with the operator's own credentials.
 */
"use strict";

const express = require("express");
const path = require("path");
const { execFile } = require("child_process");
const {
  DEFAULT_BASE, GATE_LABELS, DeltaPublic, scan, marketRegime, formatScan, buildConfig,
  btcRegimeAlign, betaGate, emaSeries, rsiSeries, cusumRegime,
} = require("./scanner");
const tradelog = require("./tradelog");
const factorlab = require("./factorlab");

const app = express();
app.use(express.json({ limit: "256kb" }));

/* ============================================================================
 * LIGHTWEIGHT IN-MEMORY RATE LIMITING (no dependencies)
 * ----------------------------------------------------------------------------
 * Fixed-window per-IP counters held in a Map. Buckets are lazily pruned on
 * access so the Map cannot grow unbounded. Returns HTTP 429 JSON when the
 * window limit is exceeded. State is per-process and in-memory only.
 * ========================================================================== */
function rateLimit(maxReq, windowMs) {
  const hits = new Map(); // ip -> { count, resetAt }
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    let b = hits.get(ip);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
      hits.set(ip, b);
    }
    b.count += 1;
    // Opportunistic prune of expired buckets to bound memory.
    if (hits.size > 1024) {
      for (const [k, v] of hits) { if (now >= v.resetAt) hits.delete(k); }
    }
    if (b.count > maxReq) {
      res.set("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: "rate limited" });
    }
    next();
  };
}
const scanLimiter = rateLimit(4, 60 * 1000);     // /api/scan ~4 req/min/IP
const telegramLimiter = rateLimit(5, 60 * 1000); // /api/telegram/* ~5 req/min/IP
const tradelogLimiter = rateLimit(20, 60 * 1000); // /api/tradelog/* ~20 req/min/IP
// Conservative per-IP limiter for the open-access POST *mutation* endpoints
// (Telegram send + outcome-log resolve). These either trigger an outbound
// message or a compute-heavy public-candle fetch, so they get a tighter bucket
// than the read-only GETs in the same namespace. Applied per-route below; the
// in-process cron resolver calls tradelog.resolveOpen directly and is unaffected.
const mutationLimiter = rateLimit(3, 60 * 1000); // ~3 mutating POSTs/min/IP
const factorlabLimiter = rateLimit(6, 60 * 1000); // /api/factorlab ~6 req/min/IP (one candle fetch each)
app.use("/api/scan", scanLimiter);
app.use("/api/telegram", telegramLimiter);
app.use("/api/factorlab", factorlabLimiter);
app.use("/api/tradelog", tradelogLimiter);
app.use("/api/log", tradelogLimiter); // backwards-compat alias namespace

// Serve the static PWA from this same folder.
app.use(express.static(__dirname, { extensions: ["html"] }));

const DATA_SOURCE = "LIVE DELTA PUBLIC DATA";
const ENDPOINTS = ["/v2/products", "/v2/tickers", "/v2/history/candles"];

/* ============================================================================
 * TELEGRAM ALERTS (manual, button-triggered only)
 * ----------------------------------------------------------------------------
 * Messages are NEVER sent automatically. A Telegram message is sent ONLY when
 * the operator presses a button in the Alerts view, which calls
 * POST /api/telegram/alert.
 *
 * The Telegram connector is reached through the `external-tool` CLI, which is
 * only present in the process environment when the server is started with
 * api_credentials=["external-tools"]. If the CLI / token is absent we return a
 * friendly, non-fatal error instead of crashing.
 *
 * SAFETY: we invoke the CLI with execFile (NO shell), passing the payload as a
 * single JSON.stringify'd argv element, so there is zero shell interpolation.
 * ========================================================================== */
const TG_SOURCE_ID = "telegram_bot_api__pipedream";
const TG_SEND_TOOL = "telegram_bot_api-send-text-message-or-reply";
const TG_LIST_TOOL = "telegram_bot_api-list-chats";
const TG_TIMEOUT_MS = 20000;
const TG_MAX_TEXT = 3500; // Telegram hard limit is 4096; keep a safe margin.

class ConnectorUnavailable extends Error {}

// Call an external connector tool via the `external-tool` CLI using execFile
// (no shell). Returns the parsed JSON result. Throws ConnectorUnavailable when
// the CLI/token is missing, and Error for connector-reported failures.
function callConnector(sourceId, toolName, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      source_id: sourceId,
      tool_name: toolName,
      arguments: args || {},
    });
    let child;
    try {
      child = execFile(
        "external-tool",
        ["call", payload],
        { timeout: TG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const out = (stdout || "").toString();
          const errOut = (stderr || "").toString();
          if (err) {
            // ENOENT => the CLI is not on PATH (server started without
            // external-tools credentials).
            if (err.code === "ENOENT") {
              return reject(new ConnectorUnavailable(
                "external-tool CLI not found — start the backend with external-tools credentials."));
            }
            if (err.killed || err.signal === "SIGTERM") {
              return reject(new Error("Telegram connector timed out."));
            }
            // The CLI emits JSON errors on stderr; surface auth_required clearly.
            let parsed = null;
            try { parsed = JSON.parse(errOut || out); } catch (_) { /* noop */ }
            if (parsed && parsed.error === "auth_required") {
              return reject(new ConnectorUnavailable(
                "Telegram connector not authorized — reconnect the Telegram connector."));
            }
            const msg = (parsed && (parsed.error || parsed.message)) || errOut || err.message;
            return reject(new Error(String(msg).slice(0, 300)));
          }
          try {
            return resolve(JSON.parse(out));
          } catch (e) {
            return reject(new Error("Could not parse connector response."));
          }
        },
      );
    } catch (e) {
      // Synchronous spawn failure (e.g. CLI missing on some platforms).
      return reject(new ConnectorUnavailable(
        "external-tool CLI unavailable — start the backend with external-tools credentials."));
    }
    if (child) {
      child.on("error", (e) => {
        if (e && e.code === "ENOENT") {
          return reject(new ConnectorUnavailable(
            "external-tool CLI not found — start the backend with external-tools credentials."));
        }
        return reject(new Error(String(e && e.message || e)));
      });
    }
  });
}

// Strip HTML-significant characters so a value is safe inside parse_mode=HTML.
function tgEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Best-effort normalization of list-chats output into [{ id, title, type }].
function normalizeChats(raw) {
  const seen = new Map();
  const add = (id, title, type) => {
    if (id == null) return;
    const key = String(id);
    if (!seen.has(key)) seen.set(key, { id: key, title: title || key, type: type || "chat" });
  };
  const visitChat = (chat) => {
    if (!chat || typeof chat !== "object") return;
    const id = chat.id != null ? chat.id : chat.chat_id;
    const title = chat.title
      || [chat.first_name, chat.last_name].filter(Boolean).join(" ")
      || chat.username
      || (id != null ? String(id) : null);
    add(id, title, chat.type);
  };
  const visitUpdate = (u) => {
    if (!u || typeof u !== "object") return;
    const m = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    if (m && m.chat) visitChat(m.chat);
    if (u.chat) visitChat(u.chat);
  };
  const walk = (node, depth) => {
    if (node == null || depth > 6) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (typeof node === "object") {
      if (node.update_id != null) visitUpdate(node);
      if (node.chat) visitChat(node.chat);
      // Some responses wrap a "chat"-like object directly.
      if (node.id != null && (node.type || node.title || node.username || node.first_name)) {
        visitChat(node);
      }
      Object.keys(node).forEach((k) => walk(node[k], depth + 1));
    }
  };
  walk(raw, 0);
  return Array.from(seen.values());
}

// GET /api/telegram/chats — list available chats, gracefully if no token.
app.get("/api/telegram/chats", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || "50", 10) || 50));
    const raw = await callConnector(TG_SOURCE_ID, TG_LIST_TOOL, { limit });
    const chats = normalizeChats(raw);
    res.json({ ok: true, connector: true, chats, count: chats.length });
  } catch (e) {
    if (e instanceof ConnectorUnavailable) {
      return res.json({
        ok: false,
        connector: false,
        chats: [],
        error: e.message,
        hint: "Restart the backend with external-tools credentials / Telegram connector required.",
      });
    }
    res.json({
      ok: false,
      connector: true,
      chats: [],
      error: String(e && e.message || e),
      hint: "Could not list chats. Send a message to your bot first, then retry, or enter the chat ID manually.",
    });
  }
});

// Build a concise, sanitized Telegram message (HTML parse_mode) for either a
// single strict 8/8 setup or a full scanner report. Server-side construction
// keeps the wording controlled and prevents arbitrary client payloads.
function buildTelegramMessage(body) {
  const setup = body && body.setup;
  if (setup && typeof setup === "object") {
    const sym = tgEscape(setup.sym || setup.symbol || "?");
    const dir = tgEscape(String(setup.dir || "").toUpperCase() || "?");
    const score = Number.isFinite(+setup.score8) ? +setup.score8
      : (Number.isFinite(+setup.score) ? +setup.score : 8);
    const fmt = (v, d) => (v == null || isNaN(+v)) ? "—" : (+v).toLocaleString("en-US", { maximumFractionDigits: d });
    const lines = [
      `\u26A1 <b>Strict ${score}/8 setup</b>`,
      `<b>${sym}</b> · ${dir}`,
    ];
    if (setup.entry != null) lines.push(`Entry: <code>${fmt(setup.entry, 6)}</code>`);
    if (setup.stop != null) lines.push(`Stop: <code>${fmt(setup.stop, 6)}</code>`);
    if (setup.target != null) lines.push(`Target: <code>${fmt(setup.target, 6)}</code>`);
    if (setup.rr != null) lines.push(`R:R: <code>${fmt(setup.rr, 2)}</code>`);

    // ---- Strategy Match block (rule-based checklist; NO win-rate/confidence%) ----
    const sm = setup.strategy;
    if (sm && typeof sm === "object") {
      lines.push("");
      lines.push("\u2014 <b>Strategy Match</b> \u2014");
      if (sm.grade) lines.push(`Grade: <b>${tgEscape(String(sm.grade))}</b>${sm.profile ? ` · ${tgEscape(String(sm.profile))}` : ""}`);
      if (sm.action) lines.push(`Action: <b>${tgEscape(String(sm.action))}</b>`);
      if (sm.sizeNote) lines.push(`Size: <code>${tgEscape(String(sm.sizeNote))}</code>`);
      const reasons = Array.isArray(sm.topReasons) ? sm.topReasons.slice(0, 6) : [];
      if (reasons.length) lines.push(`Why: ${reasons.map(t => tgEscape(String(t))).join(" · ")}`);
      lines.push(`<i>Rule-based checklist — not a probability or win rate.</i>`);
    }

    // ---- Confirmatory Signal Layer block (rule-based; NO probability/win-rate) ----
    const cf = setup.confirm;
    if (cf && typeof cf === "object") {
      lines.push("");
      lines.push("\u2014 <b>Confirmatory layer</b> \u2014");
      if (cf.statusLabel) lines.push(`Status: <b>${tgEscape(String(cf.statusLabel))}</b>`);
      if (cf.action) lines.push(`Action: <b>${tgEscape(String(cf.action))}</b>`);
      if (cf.sizeNote) lines.push(`Size adj: <code>${tgEscape(String(cf.sizeNote))}</code>`);
      const cr = Array.isArray(cf.topReasons) ? cf.topReasons.slice(0, 7) : [];
      if (cr.length) lines.push(`Confirms: ${cr.map(t => tgEscape(String(t))).join(" \u00b7 ")}`);
      lines.push(`<i>Confirms/reduces after 8/8 + Strategy Match \u2014 not a prediction engine.</i>`);
    }

    // ---- Execution plan block (optional; built client-side, sanitized here) ----
    const ex = setup.exec;
    if (ex && typeof ex === "object") {
      lines.push("");
      lines.push("\u2014 <b>Execution plan</b> \u2014");
      if (ex.status) lines.push(`Status: <b>${tgEscape(ex.status)}</b>`);
      if (ex.action) lines.push(`Action: <b>${tgEscape(ex.action)}</b>${ex.entryType ? ` · ${tgEscape(ex.entryType)}` : ""}`);
      if (ex.curPrice != null) lines.push(`Current: <code>${fmt(ex.curPrice, 6)}</code>${ex.entryDeltaPct != null ? ` (${(+ex.entryDeltaPct >= 0 ? "+" : "")}${fmt(ex.entryDeltaPct, 2)}% vs entry)` : ""}`);
      if (ex.tp1 != null) lines.push(`TP1 (1R): <code>${fmt(ex.tp1, 6)}</code>${ex.tp1Pct != null ? ` (+${fmt(ex.tp1Pct, 2)}%)` : ""} · book ${ex.tp1BookPct != null ? +ex.tp1BookPct : 50}%`);
      if (ex.tp2 != null) lines.push(`TP2 (${ex.rrTarget != null ? fmt(ex.rrTarget, 1) : "final"}R): <code>${fmt(ex.tp2, 6)}</code>${ex.tp2Pct != null ? ` (+${fmt(ex.tp2Pct, 2)}%)` : ""} · book ${ex.tp2BookPct != null ? +ex.tp2BookPct : 50}%`);
      if (ex.slPct != null) lines.push(`SL risk: <code>${fmt(ex.slPct, 2)}%</code>`);
      if (ex.beRule) lines.push(`BE: ${tgEscape(ex.beRule)}`);
      if (ex.sizing && typeof ex.sizing === "object") {
        const sz = ex.sizing;
        lines.push(`Size: <code>${tgEscape(sz.qty || "—")}</code> · notional <code>${tgEscape(sz.notional || "—")}</code> · risk <code>${tgEscape(sz.risk || "—")}</code> · max loss <code>${tgEscape(sz.maxLoss || "—")}</code>${sz.lev ? ` · ${tgEscape(sz.lev)}` : ""}`);
      }
      const inv = Array.isArray(ex.invalidation) ? ex.invalidation.slice(0, 6) : [];
      if (inv.length) {
        lines.push("Invalidation:");
        inv.forEach(b => lines.push(`• ${tgEscape(b)}`));
      }
    }

    lines.push("");
    lines.push("<i>Technical setup only — not financial advice. Follow risk size and SL. Public Delta data · scan-only · no order placed.</i>");
    return lines.join("\n").slice(0, TG_MAX_TEXT);
  }
  // Full scanner report path: accept a plain-text report string.
  let text = body && (body.report || body.text);
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Nothing to send: provide a `setup` object or `report`/`text` string.");
  }
  const header = "\uD83D\uDCE1 <b>Delta Scanner v6 — 4-family structural report</b>\n\n";
  const footer = "\n\n<i>Public Delta data · scan-only · no order placed · not financial advice.</i>";
  const budget = TG_MAX_TEXT - header.length - footer.length;
  let bodyText = tgEscape(text.trim());
  if (bodyText.length > budget) bodyText = bodyText.slice(0, budget - 1) + "\u2026";
  return header + "<pre>" + bodyText + "</pre>" + footer;
}

// POST /api/telegram/alert — send ONE message on explicit user action.
app.post("/api/telegram/alert", mutationLimiter, async (req, res) => {
  const body = req.body || {};
  const chatId = body.chatId != null ? String(body.chatId).trim() : "";
  if (!chatId) {
    return res.status(400).json({ ok: false, error: "chatId is required." });
  }
  // Accept only a numeric chat id (>=5 digits, optional leading -) or an
  // @username (>=5 word chars). Rejects anything else before forwarding.
  if (!/^-?\d{5,}$|^@[a-zA-Z0-9_]{5,}$/.test(chatId)) {
    return res.status(400).json({ ok: false, error: "invalid chatId." });
  }
  let text;
  try {
    text = buildTelegramMessage(body);
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e && e.message || e) });
  }
  const args = {
    chatId,
    text,
    parse_mode: "HTML",
    disable_notification: !!body.silent,
  };
  try {
    const raw = await callConnector(TG_SOURCE_ID, TG_SEND_TOOL, args);
    res.json({ ok: true, sent: true, chatId, chars: text.length, result: raw });
  } catch (e) {
    if (e instanceof ConnectorUnavailable) {
      return res.status(503).json({
        ok: false,
        sent: false,
        connector: false,
        error: e.message,
        hint: "Restart the backend with external-tools credentials / Telegram connector required.",
      });
    }
    res.status(502).json({
      ok: false,
      sent: false,
      connector: true,
      error: String(e && e.message || e),
      hint: "Telegram send failed. Verify the chat ID and that your bot can message that chat.",
    });
  }
});

app.get("/api/health", async (req, res) => {
  const meta = {
    ok: true,
    service: "judas-8gate-scanner",
    version: "v4",
    data_source: DATA_SOURCE,
    delta_base: DEFAULT_BASE,
    endpoints: ENDPOINTS,
    live_execution: "locked (run judas_8gate_bot.py separately)",
    gate_labels: GATE_LABELS,
    not_financial_advice: true,
    time: new Date().toISOString(),
  };
  // quick reachability probe (non-fatal)
  try {
    const client = new DeltaPublic(buildConfig({}));
    const t0 = Date.now();
    const j = await client._get("/v2/products?states=live&page_size=1");
    meta.delta_reachable = !!(j && j.success !== false);
    meta.probe_ms = Date.now() - t0;
  } catch (e) {
    meta.delta_reachable = false;
    meta.probe_error = String(e && e.message || e);
  }
  res.json(meta);
});

app.post("/api/scan", async (req, res) => {
  const started = Date.now();
  let cfg;
  try {
    cfg = buildConfig(req.body || {});
  } catch (e) {
    return res.status(400).json({ ok: false, error: "bad settings payload" });
  }
  try {
    const client = new DeltaPublic(cfg);
    const results = await scan(cfg, client);
    // Confirmatory layer: derive a coarse BTC/ETH market regime once per scan.
    // Non-fatal — if BTC data can't be fetched it returns { available:false }.
    let regime;
    try { regime = await marketRegime(client, cfg); }
    catch (e) { regime = { available: false, note: String(e && e.message || e) }; }
    // BTC-beta neutralization (req #6): annotate each row with its alignment to
    // the live BTC regime and a beta gate, then fold the gate into the simplified
    // execution status. Block (counter to a strong BTC regime) → AVOID; caution
    // downgrades ENTER → WAIT. Purely additive; no existing field is removed.
    for (const r of results) {
      if (!r || r.err) continue;
      r.btcRegimeAlign = btcRegimeAlign(regime, r.dir);
      r.betaGate = betaGate(regime, r.dir, r.correlatedExposureGroup);
      if (r.betaGate === "block") r.executionStatus = "AVOID";
      else if (r.betaGate === "caution" && r.executionStatus === "ENTER") r.executionStatus = "WAIT";
    }
    // Correlated-exposure cap (req #6): same exposure group + same direction is one
    // BTC-beta basket, not N independent bets. Rank actionable setups within each
    // basket; keep the strongest as the representative and flag the rest with a
    // warning + execution downgrade so the operator sizes the basket as ONE position.
    const exposure_baskets = [];
    {
      const baskets = new Map();
      for (const r of results) {
        if (!r || r.err || !r.dir) continue;
        if (r.executionStatus === "AVOID") continue; // already filtered out
        const key = `${r.correlatedExposureGroup || "ALT"}|${r.dir}`;
        (baskets.get(key) || baskets.set(key, []).get(key)).push(r);
      }
      for (const [key, members] of baskets) {
        members.sort((a, b) => (b.familyScore - a.familyScore) || (b.score4 - a.score4) || (b.score8 - a.score8));
        const [group, dir] = key.split("|");
        if (members.length > 1) {
          const lead = members[0];
          for (let i = 1; i < members.length; i++) {
            const r = members[i];
            r.correlatedExposureWarning =
              `Correlated BTC-beta: ${members.length} ${group} ${dir}s this scan (lead ${lead.sym}). Treat as ONE basket position, not ${members.length} independent bets.`;
            if (r.executionStatus === "ENTER") r.executionStatus = "WAIT";
          }
          exposure_baskets.push({ group, dir, count: members.length, lead: lead.sym, members: members.map(m => m.sym) });
        }
      }
    }
    const evaluated = results.filter(r => !r.err);
    const errored = results.filter(r => r.err);
    const passed = evaluated.filter(r => r.passed)
      .sort((a, b) => (b.score4 - a.score4));
    // Honest CLEAN set: all four de-correlated families + tradeable structure.
    const clean = evaluated.filter(r => r.corePass)
      .sort((a, b) => (b.familyScore - a.familyScore) || (b.score4 - a.score4));
    const kept = cfg.strict
      ? evaluated.filter(r => r.passed)
      : evaluated.filter(r => r.dir && (r.score8 || 0) >= 6)
          .sort((a, b) => (b.score8 - a.score8) || (b.score4 - a.score4));
    const report = formatScan(results, cfg);

    // Outcome log: idempotently record strict 8/8 setups as OPEN records so the
    // Outcome Lab can later resolve their real SL/TP/time outcomes. Pure data —
    // no orders. Non-fatal: a logging hiccup must never break a scan response.
    // Log the honest CLEAN set plus any legacy strict 8/8 (deduped by id) so the
    // Outcome Lab measures the model the scanner actually trades now.
    const toLog = clean.slice();
    for (const r of passed) if (!toLog.includes(r)) toLog.push(r);
    let tradelog_logged = null;
    try { tradelog_logged = tradelog.logSetup(toLog, cfg); }
    catch (e) { tradelog_logged = { error: String(e && e.message || e) }; }

    res.json({
      ok: true,
      live: true,
      data_source: DATA_SOURCE,
      delta_base: cfg.base_url,
      gate_labels: GATE_LABELS,
      market_regime: regime,    // confirmatory BTC/ETH regime (or {available:false})
      exposure_baskets,         // correlated BTC-beta baskets (req #6)
      summary: {
        universe: evaluated.length,
        requested: results.length,
        errored: errored.length,
        passed: passed.length,
        clean: clean.length,     // honest 4-family CLEAN count
        strict: cfg.strict,
        scanned_at: new Date().toISOString().slice(11, 16) + " UTC",
        took_ms: Date.now() - started,
      },
      results: evaluated,      // full evaluated set (UI filters strict/preview)
      setups: kept,            // strict 8/8 (or 6+/8 in non-strict)
      passed,                  // legacy strict 8/8 only (backward compat)
      clean,                   // honest CLEAN set (4-family + tradeable structure)
      report,                  // exact terminal report string
      tradelog: tradelog_logged,  // { logged, skipped, candidates, total } | null
      meta: {
        live_execution: "locked",
        note: "Public Delta data only. No orders placed. Not financial advice.",
      },
    });
  } catch (e) {
    res.status(422).json({
      ok: false,
      live: false,
      error: String(e && e.message || e),
      data_source: DATA_SOURCE,
      hint: "Delta public API unreachable from this host. The UI will fall back to demo data.",
    });
  }
});

/* ============================================================================
 * OUTCOME LOG / EXPECTANCY (read + resolve; pure data, never places orders)
 * ----------------------------------------------------------------------------
 * The triple-barrier labeler resolves logged setups against PUBLIC candles and
 * reports honest, measured expectancy. No private account access, no secrets.
 * ========================================================================== */

// Handlers are registered under BOTH the canonical /api/tradelog/* names (used
// by the current UI) and the legacy /api/log* aliases (reference compat). Both
// stay live; neither is removed.

// expectancy — overall / by-side / by-score expectancy.
function handleExpectancy(req, res) {
  try {
    res.json(Object.assign({ ok: true }, tradelog.expectancy({})));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// Factor evaluation over live Delta candles for ONE symbol. Pure analysis: one
// public candle fetch, deflated-Sharpe out-of-sample, no orders. Query params:
// symbol (required), resolution (default 1h), bars (default 500), ema_fast,
// ema_slow, train_frac, dsr_threshold.
// e.g. /api/factorlab?symbol=BTCUSD&resolution=1h&bars=500
async function handleFactorlab(req, res) {
  try {
    const q = req.query || {};
    const symbol = String(q.symbol || "").toUpperCase().trim();
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });
    const resolution = String(q.resolution || "1h");
    const bars = Math.max(120, Math.min(2000, parseInt(q.bars, 10) || 500));
    const cfg = buildConfig({});
    const client = new DeltaPublic(cfg);
    const candles = await client.candles(symbol, resolution, bars);
    if (!candles || candles.length < 120) {
      return res.status(404).json({ ok: false, error: `no/insufficient candles for ${symbol} @ ${resolution}` });
    }
    const numq = (v) => (v != null && Number.isFinite(parseFloat(v)) ? parseFloat(v) : undefined);
    const buildOpt = {};
    if (numq(q.ema_fast) !== undefined) buildOpt.ema_fast = numq(q.ema_fast);
    if (numq(q.ema_slow) !== undefined) buildOpt.ema_slow = numq(q.ema_slow);
    const rows = factorlab.buildFeatureRows(
      candles,
      { emaSeries, rsiSeries, cusumRegime },
      buildOpt);
    const evalOpt = {};
    if (numq(q.train_frac) !== undefined) evalOpt.train_frac = numq(q.train_frac);
    if (numq(q.dsr_threshold) !== undefined) evalOpt.dsr_threshold = numq(q.dsr_threshold);
    const out = factorlab.evaluateFactors(rows, factorlab.FACTORS, evalOpt);
    res.json(Object.assign({ ok: true, symbol, resolution, bars: candles.length }, out));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// Sweep factor evaluation across MANY symbols x timeframes, pooling the
// deflated-Sharpe correction over every cell (so a wide sweep cannot
// manufacture survivors). Query: symbols=BTCUSD,ETHUSD (required, comma-sep),
// resolutions=1h,4h (default 1h), bars, ema_fast, ema_slow, train_frac,
// dsr_threshold. Capped at 16 symbol×timeframe combos per call (one candle
// fetch each; sequential). e.g. /api/factorlab/sweep?symbols=BTCUSD,ETHUSD&resolutions=1h,4h
async function handleFactorlabSweep(req, res) {
  try {
    const q = req.query || {};
    const symbols = String(q.symbols || "").toUpperCase().split(",").map(s => s.trim()).filter(Boolean);
    const resolutions = String(q.resolutions || "1h").split(",").map(s => s.trim()).filter(Boolean);
    if (!symbols.length) return res.status(400).json({ ok: false, error: "symbols required (comma-separated)" });
    const combos = symbols.length * resolutions.length;
    if (combos > 16) return res.status(400).json({ ok: false, error: `too many combos (${combos}); max 16 symbol×timeframe per sweep` });
    const bars = Math.max(120, Math.min(2000, parseInt(q.bars, 10) || 500));
    const numq = (v) => (v != null && Number.isFinite(parseFloat(v)) ? parseFloat(v) : undefined);
    const buildOpt = {};
    if (numq(q.ema_fast) !== undefined) buildOpt.ema_fast = numq(q.ema_fast);
    if (numq(q.ema_slow) !== undefined) buildOpt.ema_slow = numq(q.ema_slow);
    const evalOpt = {};
    if (numq(q.train_frac) !== undefined) evalOpt.train_frac = numq(q.train_frac);
    if (numq(q.dsr_threshold) !== undefined) evalOpt.dsr_threshold = numq(q.dsr_threshold);
    const cfg = buildConfig({});
    const client = new DeltaPublic(cfg);
    const cells = [];
    const skipped = [];
    for (const symbol of symbols) {
      for (const resolution of resolutions) {
        let candles = null;
        try { candles = await client.candles(symbol, resolution, bars); } catch (e) { candles = null; }
        if (!candles || candles.length < 120) { skipped.push(`${symbol}|${resolution}`); continue; }
        const rows = factorlab.buildFeatureRows(candles, { emaSeries, rsiSeries, cusumRegime }, buildOpt);
        const fr = factorlab.oosFactorReturns(rows, factorlab.FACTORS, evalOpt);
        for (const factor of Object.keys(fr.perFactor)) {
          cells.push({
            key: `${symbol}|${resolution}|${factor}`, symbol, resolution, factor,
            is: fr.perFactor[factor].is, oos: fr.perFactor[factor].oos,
          });
        }
      }
    }
    if (!cells.length) return res.status(404).json({ ok: false, error: "no usable data for any requested symbol/timeframe", skipped });
    const out = factorlab.evaluatePooled(cells, evalOpt);
    res.json(Object.assign({ ok: true, symbols, resolutions, bars, skipped }, out));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// Shadow position-sizing backtest (pure analysis; no live sizing changed, no TP
// moved). Optional query overrides: base_risk_pct, kelly_fraction, kelly_cap,
// tier_min_n. e.g. /api/tradelog/sizing?base_risk_pct=1&kelly_fraction=0.25
function handleSizing(req, res) {
  try {
    const q = req.query || {};
    const numq = (v) => (v != null && Number.isFinite(parseFloat(v)) ? parseFloat(v) : undefined);
    const opt = {};
    if (numq(q.base_risk_pct) !== undefined) opt.base_risk_pct = numq(q.base_risk_pct);
    if (numq(q.kelly_fraction) !== undefined) opt.kelly_fraction = numq(q.kelly_fraction);
    if (numq(q.kelly_cap) !== undefined) opt.kelly_cap = numq(q.kelly_cap);
    if (numq(q.tier_min_n) !== undefined) opt.tier_min_n = numq(q.tier_min_n);
    res.json(Object.assign({ ok: true }, tradelog.sizingShadow(opt)));
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// recent?limit=50 — reconciled records, newest first.
function handleRecent(req, res) {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || "50", 10) || 50));
    const records = tradelog.recent(limit);
    res.json({ ok: true, count: records.length, records });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}

// resolve — resolve open setups using public candles via the SAME DeltaPublic
// client the scanner uses. Rate-limited; never places orders.
async function handleResolve(req, res) {
  let cfg;
  try { cfg = buildConfig(req.body || {}); }
  catch (e) { return res.status(400).json({ ok: false, error: "bad settings payload" }); }
  try {
    const client = new DeltaPublic(cfg);
    const result = await tradelog.resolveOpen(client, cfg);
    const summary = tradelog.expectancy({});
    res.json({ ok: true, resolved: result, expectancy: summary, note: "Public Delta data only. No orders placed." });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message || e), hint: "Delta public API unreachable — try again shortly." });
  }
}

// Canonical (UI) routes.
app.get("/api/tradelog/expectancy", handleExpectancy);
app.get("/api/tradelog/sizing", handleSizing);
app.get("/api/factorlab", handleFactorlab);
app.get("/api/factorlab/sweep", handleFactorlabSweep);
app.get("/api/tradelog/recent", handleRecent);
app.post("/api/tradelog/resolve", mutationLimiter, handleResolve);
// Legacy aliases (reference compat): /api/log -> expectancy, /api/log/raw ->
// recent records, /api/log/resolve -> resolve.
app.get("/api/log", handleExpectancy);
app.get("/api/log/raw", handleRecent);
app.post("/api/log/resolve", mutationLimiter, handleResolve);

/* ============================================================================
 * OPTIONAL SELF-MAINTAINING RESOLVER (off by default)
 * ----------------------------------------------------------------------------
 * If RESOLVE_INTERVAL_MIN is set to a positive number, the server periodically
 * resolves open outcome-log records against PUBLIC candles so expectancy stays
 * current without manual taps. Pure data — it ONLY calls tradelog.resolveOpen
 * (public Delta candles); it never places orders or touches private accounts.
 * Unset/zero (the default) preserves the prior behavior: no background work.
 * ========================================================================== */
function startBackgroundResolver() {
  const mins = parseFloat(process.env.RESOLVE_INTERVAL_MIN);
  if (!(mins > 0)) return; // disabled by default
  const periodMs = Math.max(1, mins) * 60 * 1000;
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      const cfg = buildConfig({});
      const client = new DeltaPublic(cfg);
      const r = await tradelog.resolveOpen(client, cfg);
      if (r && r.resolved) console.log(`[resolver] resolved ${r.resolved}/${r.checked} open (errors ${r.errors})`);
    } catch (e) {
      console.log(`[resolver] skipped: ${String(e && e.message || e)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, periodMs);
  if (timer.unref) timer.unref(); // do not keep the process alive on its own
  console.log(`Background outcome resolver enabled: every ${mins} min (public data only, no orders).`);
}

const PORT = parseInt(process.env.PORT || "8000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Judas 8-gate scanner backend listening on 0.0.0.0:${PORT}`);
  console.log(`Data source: ${DATA_SOURCE} (${DEFAULT_BASE})`);
  startBackgroundResolver();
});
