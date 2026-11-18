// Trade Finder - GET /api/notify: the 15-minute check behind phone alerts (called by a GitHub schedule).
// 1. New "Get in now" callouts: push one alert per callout to each phone (on that phone's chart setting).
// 2. Watch-line alerts: when price reaches a line someone asked about, alert once and remove it.
// 3. Live track record: every callout that was sent is saved, and updated until it closes, with exit alerts
//    (stop moved, trade closed).
// Runs at most once every 9 minutes however often it's called, so calling it is harmless.
const S = require("./_store.js"), P = require("./_push.js");
const { vapid, subjectOf } = require("./push.js");

// Bump when the callout rules change, so open callouts sent under the old rules get re-checked (and dropped if
// today's rules wouldn't make them). "2": a tap must hold for 2 candles.
const RULES_VERSION = "3";
const FRESH = 6 * 3600;   // only callouts that fired in the last 6 hours are sent (never old ones on the first run)
const ENTER_R = 0.5;      // same as the page: still within 0.5R of entry
const keyOf = (m, s) => m.sym + "|" + s.tf + "|" + s.setup + "|" + s.dir + "|" + s.t;
const show = (sym) => String(sym).replace(/=F$/, "");
const actionOf = (m, s) => (m.kind === "stocks" ? (s.dir === "long" ? "BUY CALL" : "BUY PUT") : s.dir === "long" ? "BUY" : "SELL");

function reply(res, obj) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (!S.config()) return reply(res, { ran: false, reason: "no database" });
  try {
    if (!(await S.one("SET", "tf:lastrun", String(Date.now()), "NX", "EX", 540))) return reply(res, { ran: false, reason: "ran recently" });
    const base = "https://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const subs = await S.hgetallJSON("tf:subs"), live = await S.hgetallJSON("tf:live"), keys = await vapid(), subject = subjectOf(req);
    const now = Date.now() / 1000;
    const get = (path) => fetch(base + path, { signal: AbortSignal.timeout(55000) }).then((r) => r.json()).catch(() => ({}));
    // Prices and callouts for each chart setting in use (or tracked in the live record).
    const tfs = [...new Set(Object.values(subs).map((x) => (x.prefs && x.prefs.tf) || "4H").concat(Object.values(live).filter((x) => x.status === "open").map((x) => x.view || "4H")))];
    const byTf = {};
    for (const tf of tfs) {
      const [a, b] = await Promise.all([get("/api/trades?tf=" + tf), get("/api/scan?tf=" + tf)]);
      byTf[tf] = (a.markets || []).concat(b.markets || []).filter((m) => !m.error);
    }
    // Symbols with line alerts or open live trades that aren't in those lists (e.g. a stock with no setup now).
    for (const tf of tfs) {
      const have = new Set(byTf[tf].map((m) => m.sym)), want = new Set();
      Object.values(subs).forEach((x) => (x.alerts || []).forEach((a) => { if ((a.view || x.prefs.tf) === tf && !have.has(a.sym)) want.add(a.sym); }));
      Object.values(live).forEach((x) => { if (x.status === "open" && (x.view || "4H") === tf && !have.has(x.sym)) want.add(x.sym); });
      if (want.size) byTf[tf] = byTf[tf].concat(((await get("/api/trades?tf=" + tf + "&s=" + encodeURIComponent([...want].slice(0, 24).join(",")))).markets || []).filter((m) => !m.error));
    }
    const sendAll = async (filter, msg) => {
      let n = 0;
      for (const [ep, x] of Object.entries(subs)) {
        if (!filter(x)) continue;
        const r = await P.send(x.sub, msg, keys, subject);
        if (r === "gone") { await S.hdel("tf:subs", ep); delete subs[ep]; } else if (r === "sent") n++;
      }
      return n;
    };
    let notified = 0, alerted = 0;
    // 1 + 3: new callouts you can get into now -> alert, and start tracking them.
    for (const tf of tfs) {
      for (const m of byTf[tf]) {
        for (const s of m.signals || []) {
          if (s.status !== "open" || s.liveThrough || s.nowR == null || s.nowR > ENTER_R || now - s.t > FRESH) continue;
          const k = keyOf(m, s);
          if (!(await S.one("SADD", "tf:sent:" + tf, k))) continue; // already sent
          // Stocks: save the option contract the site would suggest right now (price, delta, daily time decay,
          // spread), so the recent-trades list can estimate what the trade did as an option.
          let opt = null;
          if (m.kind === "stocks") {
            const tq = s.target && s.target.price != null ? "&target=" + s.target.price : "";
            const oc = await get("/api/options?sym=" + encodeURIComponent(m.sym) + "&dir=" + s.dir + "&entry=" + s.entry + "&stop=" + s.stop0 + tq), c = oc && oc.contracts && oc.contracts[0];
            if (c) opt = { contract: c.contract, type: c.type, strike: c.strike, expiry: c.expiry, dte: c.dte, mid: c.mid, delta: c.delta, gamma: c.gamma, theta: c.theta, iv: c.iv, spreadPct: c.spreadPct, atStop: c.atStop, price: oc.price };
          }
          await S.hsetJSON("tf:live", tf + "|" + k, { key: k, view: tf, sym: m.sym, kind: m.kind, tf: s.tf, setup: s.setup, grade: s.grade, dir: s.dir, entry: s.entry, stop: s.stop0, risk: s.risk, t: s.t, at: Date.now(), status: "open", nowR: s.nowR, exitR: null, rv: RULES_VERSION, ...(opt ? { opt } : {}), ...(s.target ? { target: s.target } : {}), ...(s.chart && s.chart.levels ? { levels: s.chart.levels } : {}) });
          live[tf + "|" + k] = { status: "open" };
          notified += await sendAll((x) => ((x.prefs && x.prefs.tf) || "4H") === tf, {
            title: actionOf(m, s) + " " + show(m.sym), tag: k, url: "/",
            body: s.tf + " " + s.setup + " · " + s.grade + " · entry " + s.entry + " · stop " + s.stop + " (trail it on the safety line)",
          });
        }
      }
    }
    // 2: watch-line alerts.
    for (const [ep, x] of Object.entries(subs)) {
      const tf = (x.prefs && x.prefs.tf) || "4H", keep = [];
      for (const a of x.alerts || []) {
        const m = (byTf[tf] || []).find((q) => q.sym === a.sym);
        if (!m) { keep.push(a); continue; }
        const w = (m.watch || []).find((q) => q.key === a.key), level = w ? w.lineNow : a.level, price = m.price;
        if (a.dir === "above" ? price >= level : price <= level) {
          const r = await P.send(x.sub, { title: show(a.sym) + " reached your line", body: (a.label || "Trendline") + " at " + level + " · price " + price + ". Watch for a 4H close through it or a bounce.", tag: "line-" + a.id, url: "/" }, keys, subject);
          if (r === "sent") alerted++;
          if (r === "gone") { await S.hdel("tf:subs", ep); break; }
        } else keep.push({ ...a, level });
      }
      if (subs[ep] && keep.length !== (x.alerts || []).length) await S.hsetJSON("tf:subs", ep, { ...x, alerts: keep });
    }
    // 3: update open trades in the live record (same rules as the replay: safety line, or a newer callout replaces it).
    // Exit alerts too: when the stop trails to a new level (0.1R or more), and when the trade closes.
    const R1 = (v) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + "%"; // account % at 1% risk per trade, like the page
    let exits = 0;
    let dropped = 0;
    for (const [lk, x] of Object.entries(await S.hgetallJSON("tf:live"))) {
      if (x.status !== "open") continue;
      // One-time cleanup: the SBUX short from the false 3rd tap (the break candle) is taken off tracking for good.
      if (x.sym === "SBUX") { await S.hdel("tf:live", lk); dropped++; continue; }
      const view = x.view || "4H";
      // Rules changed since this callout went out? Check once per rules version that today's rules still make it
      // (the replay has it). If not, e.g. a 3rd "tap" that was really the start of the break, drop it from tracking.
      // Done before anything else: a stock that's no longer in the scan's results still gets checked.
      if (x.rv !== RULES_VERSION) {
        const chk = await get("/api/trades?s=" + encodeURIComponent(x.sym) + "&tf=" + view + "&ct=" + x.t + "&cd=" + x.dir), cm = (chk.markets || [])[0];
        if (cm && !cm.error && !cm.trade) { await S.hdel("tf:live", lk); dropped++; continue; }
        if (cm && cm.trade) { x.rv = RULES_VERSION; await S.hsetJSON("tf:live", lk, x); }
      }
      const m = (byTf[view] || []).find((q) => q.sym === x.sym);
      if (!m) continue;
      const s = (m.signals || []).find((q) => keyOf(m, q) === x.key), sign = x.dir === "long" ? 1 : -1;
      const toView = (q) => ((q.prefs && q.prefs.tf) || "4H") === view, name = actionOf(m, x) + " " + show(x.sym);
      if (s && s.status === "closed") {
        Object.assign(x, { status: "closed", exitR: s.exitR, exitPx: s.exitPx, closedAt: Date.now(), how: s.exitHow, ...(s.exitTo ? { exitTo: s.exitTo } : {}) });
        const dd = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
        const hit = s.exitTo ? (s.exitTo.kind === "sr" ? (x.dir === "long" ? "Resistance" : "Support") + " reached at " + s.exitTo.price + " (price turned there " + s.exitTo.touches + " times)" : "The " + s.exitTo.tf + " trendline (" + dd(s.exitTo.t0) + " to " + dd(s.exitTo.t1) + ") reached") : null;
        exits += await sendAll(toView, { title: "Exit " + name + ": " + R1(s.exitR), tag: "exit-" + x.key, url: "/",
          body: (s.exitHow === "stop order" ? "Stop order hit" : s.exitHow === "take profit" ? hit || "Target reached (a bigger-timeframe trendline" + (x.kind === "futures" ? " or support/resistance level" : "") + ")" : "A " + x.tf + " candle closed through the safety line") + (s.exitPx != null ? " at " + s.exitPx : "") + ". Trade over: " + R1(s.exitR) + "." });
      } else if (s) {
        x.nowR = s.nowR;
        if (s.target) x.target = s.target; // the latest target line (it moves with the line), for "why it exited"
        if (s.chart && s.chart.levels) x.levels = s.chart.levels; // and the chart's S/R levels
        const was = x.stopNow != null ? x.stopNow : x.stop;
        if (s.stop != null && was != null && sign * (s.stop - was) >= 0.1 * x.risk) {
          x.stopNow = s.stop;
          exits += await sendAll(toView, { title: "Move stop: " + name, tag: "stop-" + x.key, url: "/",
            body: "New stop " + s.stop + " (was " + was + "), trailing the safety line. Trade now " + R1(s.nowR) + "." });
        }
      } else if ((m.signals || []).length) {
        const r = Math.round(((sign * (m.price - x.entry)) / x.risk) * 100) / 100;
        Object.assign(x, { status: "closed", exitR: r, exitPx: m.price, closedAt: Date.now(), how: "replaced by a newer callout" });
        exits += await sendAll(toView, { title: "Exit " + name + ": " + R1(r), tag: "exit-" + x.key, url: "/",
          body: "A newer callout on " + show(x.sym) + " replaces this trade. Close it near " + m.price + " (" + R1(r) + ")." });
      } else x.nowR = Math.round(((sign * (m.price - x.entry)) / x.risk) * 100) / 100;
      await S.hsetJSON("tf:live", lk, x);
    }
    reply(res, { ran: true, notified, alerted, exits, dropped, phones: Object.keys(subs).length });
  } catch (e) {
    reply(res, { ran: false, error: e.message || "failed" });
  }
};
