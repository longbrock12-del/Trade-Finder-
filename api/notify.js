// Trade Finder - GET /api/notify: the 15-minute check behind phone alerts (called by a GitHub schedule).
// 1. New "Get in now" callouts: push one alert per callout to each phone (on that phone's chart setting).
// 2. Watch-line alerts: when price reaches a line someone asked about, alert once and remove it.
// 3. Live track record: every callout that was sent is saved, and updated until it closes, with exit alerts
//    (stop moved, trade closed).
// Runs at most once every 9 minutes however often it's called, so calling it is harmless.
const S = require("./_store.js"), P = require("./_push.js"), TL = require("./_trendlines.js"), HR = require("./_hours.js");
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

// Points A and B of a callout's trend line (the one it broke or tagged) and its safety line, with the candle
// times and prices, so they can be drawn exactly on TradingView.
function ptsOf(s) {
  const pick = (L) => L && L.t0 ? { t0: L.t0, p0: L.p0, t1: L.t1, p1: L.p1, d0: !!L.d0, d1: !!L.d1 } : null, o = {};
  if (s.chart && pick(s.chart.line)) o.linePts = pick(s.chart.line);
  if (s.chart && pick(s.chart.safety)) o.safetyPts = pick(s.chart.safety);
  return o;
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
    // Saving CPU (Vercel's free plan: 4 CPU hours a month). The 112-stock scan only runs while the stock market is
    // open, once per 4-hour candle (stock callouts only happen when a candle closes): about 3 times a weekday instead
    // of 96 times a day. Futures only while they trade. Open trades and line alerts are still checked every
    // 15 minutes below, one symbol at a time.
    const nowMs = Date.now(), all = process.env.TF_ALL_HOURS === "1"; // (tests: ignore market hours)
    const runStocks = all || (HR.stocksOpen(nowMs) && !!(await S.one("SET", "tf:scanned:" + HR.stockCandle(nowMs), "1", "NX", "EX", 86400))), runFut = all || HR.futuresOpen(nowMs);
    for (const tf of tfs) {
      const [a, b] = await Promise.all([runFut ? get("/api/trades?tf=" + tf) : {}, runStocks ? get("/api/scan?tf=" + tf) : {}]);
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
          await S.hsetJSON("tf:live", tf + "|" + k, { key: k, view: tf, sym: m.sym, kind: m.kind, tf: s.tf, setup: s.setup, grade: s.grade, dir: s.dir, entry: s.entry, stop: s.stop0, risk: s.risk, t: s.t, at: Date.now(), status: "open", nowR: s.nowR, exitR: null, rv: RULES_VERSION, ...(opt ? { opt } : {}), ...(s.target ? { target: s.target } : {}), ...(s.chart && s.chart.levels ? { levels: s.chart.levels } : {}), ...ptsOf(s) });
          live[tf + "|" + k] = { status: "open" };
          // Each phone's Focus (her 1-1-1 rule): stocks only for its top-10 list. The callout is still recorded above.
          const wants = (x) => { const f = (x.prefs && x.prefs.focus) || {}; return m.kind !== "stocks" || !f.stocks || f.stocks.includes(m.sym); };
          notified += await sendAll((x) => ((x.prefs && x.prefs.tf) || "4H") === tf && wants(x), {
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
    // Today in New York, and earnings for the stocks you're in (for the 2-days-ahead warning).
    const nyDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" }), today = nyDay(Date.now());
    const openStocks = [...new Set(Object.values(live).filter((x) => x.status === "open" && x.kind === "stocks").map((x) => x.sym))];
    const earn = openStocks.length ? ((await get("/api/earnings?s=" + encodeURIComponent(openStocks.join(",")))).earnings || {}) : {};
    let dropped = 0;
    for (const [lk, x] of Object.entries(await S.hgetallJSON("tf:live"))) {
      // One-time fix: the BAC short closed early on a target "line" that wasn't a real trendline (fixed since).
      // Today's rules still have it open at the same entry, so it goes back to open and keeps running.
      if (x.key === "BAC|4H|break & retest|short|1794940200" && x.status === "closed" && x.how === "take profit" && !x.reopened) {
        ["exitR", "exitPx", "closedAt", "how", "exitTo"].forEach((k) => delete x[k]);
        Object.assign(x, { status: "open", reopened: true });
        await S.hsetJSON("tf:live", lk, x);
      }
      // Second one-time fix: it closed again on an S/R level 19 cents from the entry (49.26) when stocks got the S/R
      // exit; S/R exits now need to be at least 0.5R away, so it goes back to open and keeps running.
      if (x.key === "BAC|4H|break & retest|short|1794940200" && x.status === "closed" && x.how === "take profit" && x.exitTo && x.exitTo.kind === "sr" && !x.reopened2) {
        ["exitR", "exitPx", "closedAt", "how", "exitTo"].forEach((k) => delete x[k]);
        Object.assign(x, { status: "open", reopened2: true });
        await S.hsetJSON("tf:live", lk, x);
      }
      // The option contract you took on it (BAC Dec 18 $50 put at 1.85; the site didn't save one back then).
      // Delta, gamma, time decay and spread from the Nov 19 Cboe quote, with delta worked back to the 49.45 entry.
      if (x.key === "BAC|4H|break & retest|short|1794940200" && !x.opt) {
        x.opt = { contract: "BAC261218P00050000", type: "put", strike: 50, expiry: "2026-12-18", dte: 31, mid: 1.85, delta: -0.576, gamma: 0.1044, theta: -0.023, iv: 26.5, spreadPct: 3.6, atStop: 1.09, price: 49.45, manual: true };
        await S.hsetJSON("tf:live", lk, x);
      }
      // One-time: points A and B for the two trades open before they were saved (worked out from the same
      // Yahoo candles the site uses): HOOD's short (Nov 23) and MCD's long (Nov 24).
      if (x.status === "open" && !x.linePts && x.sym === "HOOD" && x.dir === "short") { Object.assign(x, { linePts: {t0: 1722864600, p0: 13.979999542236328, t1: 1794925800, p1: 67.25360107421875, d0: true, d1: false}, safetyPts: {t0: 1794421800, p0: 86.14990234375, t1: 1795098600, p1: 74.04000091552734, d0: false, d1: false} }); await S.hsetJSON("tf:live", lk, x); }
      if (x.status === "open" && !x.linePts && x.sym === "MCD" && x.dir === "long") { Object.assign(x, { linePts: {t0: 1794321000, p0: 283.5295104980469, t1: 1795185000, p1: 278.2900085449219, d0: false, d1: false}, safetyPts: {t0: 1791984600, p0: 234.2301025390625, t1: 1795098600, p1: 267.4704895019531, d0: false, d1: false} }); await S.hsetJSON("tf:live", lk, x); }
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
      // An open stock trade with no option contract saved (the lookup at callout time found none, e.g. HOOD's
      // callout came while the market was closed and spreads were too wide): look up the best contract now,
      // during market hours, and save it with when and at what stock price, so the trade has one to go by.
      if (x.kind === "stocks" && !x.opt && (all || HR.stocksOpen(nowMs))) {
        const tq = x.target && x.target.price != null ? "&target=" + x.target.price : "";
        const oc = await get("/api/options?sym=" + encodeURIComponent(x.sym) + "&dir=" + x.dir + "&entry=" + x.entry + "&stop=" + x.stop + tq), c = oc && oc.contracts && oc.contracts[0];
        if (c) {
          x.opt = { contract: c.contract, type: c.type, strike: c.strike, expiry: c.expiry, dte: c.dte, mid: c.mid, delta: c.delta, gamma: c.gamma, theta: c.theta, iv: c.iv, spreadPct: c.spreadPct, atStop: c.atStop, price: oc.price, late: Date.now() };
          await S.hsetJSON("tf:live", lk, x);
        }
      }
      const m = (byTf[view] || []).find((q) => q.sym === x.sym);
      if (!m) continue;
      let s = (m.signals || []).find((q) => keyOf(m, q) === x.key);
      const sign = x.dir === "long" ? 1 : -1;
      // Older than the scan's few recent days: look the trade up in the replay (like the tracking chart does).
      if (!s) { const lk2 = await get("/api/trades?s=" + encodeURIComponent(x.sym) + "&tf=" + view + "&ct=" + x.t + "&cd=" + x.dir + "&why=track"), tm = (lk2.markets || [])[0]; if (tm && tm.trade) s = tm.trade; }
      const toView = (q) => ((q.prefs && q.prefs.tf) || "4H") === view, name = actionOf(m, x) + " " + show(x.sym);
      // A rule change can make the replay "close" a trade in the past (an exit dated before we last saw it open,
      // like BAC on a support 19 cents from entry). That never happened live, so it's ignored: the trade stays open
      // and is managed with the stop and target it already has (held), until price really reaches one of them.
      const seen = x.seen || (x.at ? x.at / 1000 : x.t), nowS = Date.now() / 1000;
      const retro = s && s.status === "closed" && s.exitT != null && s.exitT < seen - 4 * 3600;
      const newer = (m.signals || []).some((q) => q.t > x.t && q.status !== "no-safety");
      // 1. Crude: she gets out before the contract switches. Close the trade the day before the front contract's
      //    last trading day, at today's price, and tell the phone.
      if (/^M?CL=F$/.test(x.sym)) {
        const left = TL.crudeDaysLeft(today);
        if (left != null && left <= 1) {
          const r = Math.round(((sign * (m.price - x.entry)) / x.risk) * 100) / 100;
          Object.assign(x, { status: "closed", exitR: r, exitPx: m.price, closedAt: Date.now(), how: "contract switch" });
          exits += await sendAll(toView, { title: "Exit " + name + ": " + R1(r), tag: "exit-" + x.key, url: "/",
            body: "Close it before the contract switches (the front contract's last trading day is " + (left === 0 ? "today" : "tomorrow") + "), near " + m.price + ". Trade over: " + R1(r) + "." });
          await S.hsetJSON("tf:live", lk, x);
          continue;
        }
      }
      // 2. Stocks: earnings in the next 2 days can gap right past the stop (and option prices drop after). Warn once.
      const er = x.kind === "stocks" && earn[x.sym];
      if (er) {
        x.earnings = er;
        const daysTo = Math.round((Date.parse(er.date + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 86400000);
        if (daysTo >= 0 && daysTo <= 2 && x.earnWarned !== er.date) {
          x.earnWarned = er.date;
          exits += await sendAll(toView, { title: "Earnings soon: " + show(x.sym), tag: "earn-" + x.key, url: "/",
            body: show(x.sym) + " reports " + (daysTo === 0 ? "today" : daysTo === 1 ? "tomorrow" : "in 2 days") + (er.when ? " " + er.when : "") + ". A gap can jump past your stop, and option prices drop after. Consider closing before." });
        }
      } else if (x.earnings) delete x.earnings;
      if (retro || (x.held && !(s && s.status === "open")) || (!s && !newer)) {
        x.held = true;
        const stopH = x.stopLive != null ? x.stopLive : x.stopNow != null ? x.stopNow : x.stop, tgH = x.target && x.target.price;
        const hitStop = stopH != null && sign * (m.price - stopH) <= 0, hitTg = tgH != null && sign * (m.price - tgH) >= 0;
        if (hitStop || hitTg) {
          const px = hitStop ? stopH : tgH, r = Math.round(((sign * (px - x.entry)) / x.risk) * 100) / 100;
          Object.assign(x, { status: "closed", exitR: r, exitPx: px, closedAt: Date.now(), how: hitStop ? "stop order" : "take profit" });
          exits += await sendAll(toView, { title: "Exit " + name + ": " + R1(r), tag: "exit-" + x.key, url: "/",
            body: (hitStop ? "Stop order hit at " : "Target reached at ") + px + ". Trade over: " + R1(r) + "." });
        } else x.nowR = Math.round(((sign * (m.price - x.entry)) / x.risk) * 100) / 100;
      } else if (s && s.status === "closed") {
        Object.assign(x, { status: "closed", exitR: s.exitR, exitPx: s.exitPx, closedAt: Date.now(), how: s.exitHow, ...(s.exitTo ? { exitTo: s.exitTo } : {}) });
        const dd = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
        const hit = s.exitTo ? (s.exitTo.kind === "sr" ? (x.dir === "long" ? "Resistance" : "Support") + " reached at " + s.exitTo.price + " (price turned there " + s.exitTo.touches + " times)" : "The " + s.exitTo.tf + " trendline (" + dd(s.exitTo.t0) + " to " + dd(s.exitTo.t1) + ") reached") : null;
        exits += await sendAll(toView, { title: "Exit " + name + ": " + R1(s.exitR), tag: "exit-" + x.key, url: "/",
          body: (s.exitHow === "stop order" ? "Stop order hit" : s.exitHow === "take profit" ? hit || "Target reached (a bigger-timeframe trendline or support/resistance level)" : "A " + x.tf + " candle closed through the safety line") + (s.exitPx != null ? " at " + s.exitPx : "") + ". Trade over: " + R1(s.exitR) + "." });
      } else if (s) {
        x.nowR = s.nowR;
        if (s.target) x.target = s.target; // the latest target line (it moves with the line), for "why it exited"
        if (s.stop != null) x.stopLive = s.stop; // where the trailing stop is right now (stopNow only moves with an alert)
        if (s.line != null) x.line = s.line; // the safety line right now (a candle closing past it ends the trade)
        Object.assign(x, ptsOf(s)); // the trend line's and safety line's points A and B, to draw them on any chart
        if (s.chart && s.chart.levels) x.levels = s.chart.levels; // and the chart's S/R levels
        const was = x.stopNow != null ? x.stopNow : x.stop;
        // 3. Every time the trailing stop moves (each new 4-hour candle along a sloped safety line), not only big moves.
        if (s.stop != null && was != null && sign * (s.stop - was) > 1e-6) {
          x.stopNow = s.stop;
          exits += await sendAll(toView, { title: "Move stop: " + name, tag: "stop-" + x.key, url: "/",
            body: "New stop " + s.stop + " (was " + was + "), trailing the safety line" + (s.line != null ? " (" + s.line + ")" : "") + ". Trade now " + R1(s.nowR) + "." });
        }
      } else if (newer) {
        const r = Math.round(((sign * (m.price - x.entry)) / x.risk) * 100) / 100;
        Object.assign(x, { status: "closed", exitR: r, exitPx: m.price, closedAt: Date.now(), how: "replaced by a newer callout" });
        exits += await sendAll(toView, { title: "Exit " + name + ": " + R1(r), tag: "exit-" + x.key, url: "/",
          body: "A newer callout on " + show(x.sym) + " replaces this trade. Close it near " + m.price + " (" + R1(r) + ")." });
      } else x.nowR = Math.round(((sign * (m.price - x.entry)) / x.risk) * 100) / 100;
      if (x.status === "open") { x.seen = nowS; if (s && s.status === "open") delete x.held; } // last time it was seen running
      await S.hsetJSON("tf:live", lk, x);
    }
    reply(res, { ran: true, notified, alerted, exits, dropped, phones: Object.keys(subs).length, scanned: { stocks: runStocks, futures: runFut } });
  } catch (e) {
    reply(res, { ran: false, error: e.message || "failed" });
  }
};
