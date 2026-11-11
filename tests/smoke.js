// Trade Finder - smoke test. Run before pushing:  node tests/smoke.js
// Uses saved Yahoo data in tests/fixtures, so no live prices are fetched:
//   yahoo_<X>.json        6 months of hourly bars to Nov 9 2026 (gold, crude, Dow, platinum futures; AAPL; AMZN to Nov 10;
//                         "TEST" = the Dow cut to stock hours)
//   yahoo_daily_<X>.json  10 years of daily bars for the same markets (TEST uses the Dow's)
//   cboe_AAPL.json        a Cboe AAPL options chain, trimmed to 120 days and strikes within 20%
// Checks the scanner follows the strategy rules, then loads the page in a headless browser.
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium). Exits 1 on failure.
const path = require("path"), fs = require("fs"), { spawn } = require("child_process");
const ROOT = path.join(__dirname, ".."), FX = path.join(__dirname, "fixtures"), PORT = 3000 + Math.floor(Math.random() * 900) + 50;
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { console.error("Playwright is not installed: npm i -g playwright && npx playwright install chromium"); process.exit(2); }

let failed = 0;
const ok = (cond, what, extra) => { console.log((cond ? "  pass  " : "  FAIL  ") + what + (extra != null && !cond ? "  (" + extra + ")" : "")); if (!cond) failed++; };
const fx = (f) => path.join(FX, f);
const load = (f) => JSON.parse(fs.readFileSync(fx(f)));
const NOW = 1794264531;
const AMZN_NOW = 1794340000; // the AMZN data was saved later (Nov 10 2026) // when the saved data was taken (Nov 9 2026, 5:48 PM New York), so the forming candle stays forming

const YF = { "PL=F": "PL", "CL=F": "CL", "GC=F": "GC", "YM=F": "YM", TEST: "TEST", AAPL: "AAPL", "MGC=F": "GC", "MCL=F": "CL" }; // micros trade at the full-size price
// A fake Yahoo: hourly or daily saved bars for the symbols above, 404 for anything else.
function fakeYahoo(map) {
  return async (u) => {
    u = decodeURIComponent(String(u));
    const s = u.match(/chart\/([^?]+)/)[1], f = map(s);
    if (!f) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => load((/interval=1d/.test(u) ? "yahoo_daily_" : "yahoo_") + f + ".json") };
  };
}
async function call(file, url, fetcher, now = NOW * 1000) {
  const saved = global.fetch, realNow = Date.now;
  global.fetch = fetcher; Date.now = () => now;
  const handler = require(path.join(ROOT, file));
  const out = await new Promise((r) => { const res = { statusCode: 200, setHeader() {}, end(b) { r({ status: res.statusCode, body: JSON.parse(b) }); } }; handler({ method: "GET", url }, res); });
  global.fetch = saved; Date.now = realNow;
  return out;
}
const tradesApi = (url) => call("api/trades.js", url, fakeYahoo((s) => YF[s]));

async function scannerTests() {
  console.log("Scanner");
  const { hourly, fourHour, oneHour, chain, scan } = require(path.join(ROOT, "api/_trendlines.js"));
  const etH = (t) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t * 1000)).replace(/^24/, "00");
  const fut = fourHour(hourly(load("yahoo_GC.json")).bars, true, 2e9);
  ok(fut.every((b) => ["18:00", "22:00", "02:00", "06:00", "10:00", "14:00"].includes(etH(b.t))), "futures 4H candles start 6 PM, 10 PM, 2 AM, 6 AM, 10 AM, 2 PM New York", etH(fut[0].t));
  const stk = fourHour(hourly(load("yahoo_AAPL.json")).bars, false, 2e9);
  ok(stk.length > 200 && stk.every((b) => ["09:30", "13:30"].includes(etH(b.t))), "stock 4H candles start 9:30 and 1:30", stk.length + " " + etH(stk[0].t));
  const h1 = oneHour(hourly(load("yahoo_AAPL.json")).bars, false, 2e9);
  ok(h1.length > 800 && h1.every((b) => { const [h, m] = etH(b.t).split(":").map(Number); return h * 60 + m >= 570 && h * 60 + m < 960; }), "stock 1H candles are regular hours only");

  // Her line rules on 10 years of real gold lows and highs: start at the extreme, each line steeper than the
  // last (point B becomes point A), and no candle pokes through any line.
  const gd = hourly(load("yahoo_daily_GC.json")).bars;
  [["l", true], ["h", false]].forEach(([k, up]) => {
    const pts = gd.map((b, i) => ({ x: i, p: b[k], t: b.t })), c = chain(pts, up), ext = up ? Math.min(...pts.map((q) => q.p)) : Math.max(...pts.map((q) => q.p));
    const sl = c.slice(1).map((q, i) => (q.p - c[i].p) / (q.x - c[i].x));
    const poke = c.slice(1).some((q, i) => pts.some((r) => r.x >= c[i].x && (up ? r.p < c[i].p + sl[i] * (r.x - c[i].x) - 1e-6 : r.p > c[i].p + sl[i] * (r.x - c[i].x) - -1e-6)));
    ok(c[0].p === ext && sl.every((s, i) => !i || (up ? s > sl[i - 1] : s < sl[i - 1])) && !poke,
      (up ? "rising" : "falling") + " chain: starts at the " + (up ? "lowest" : "highest") + " point, each line " + (up ? "steeper" : "steeper down") + ", nothing pokes through (" + (c.length - 1) + " lines)");
  });

  const api = await tradesApi("/api/trades?s=PL=F,CL=F,GC=F,YM=F,TEST,ZZZ,bad%20sym,MGC=F");
  const M = api.body.markets;
  ok(api.status === 200 && M.length === 7, "API scans each valid symbol and drops junk ones", M.map((m) => m.sym).join(","));
  ok(M.find((m) => m.sym === "ZZZ").error === "unknown symbol", "unknown symbol comes back as an error, not a crash");
  const good = M.filter((m) => !m.error), sigs = [], watch = [];
  ok(good.length === 6 && good.every((m) => m.price > 0 && m.dailyBars > 2000), "every market has a price and 10 years of daily candles");
  // Rule checks run on every callout the scanner finds (all: true), not just the newest one per market.
  const full = {};
  good.forEach((m) => {
    full[m.sym] = scan(load("yahoo_" + YF[m.sym] + ".json"), load("yahoo_daily_" + YF[m.sym] + ".json"), { sym: m.sym, all: true, now: NOW });
    full[m.sym].signals.forEach((s) => sigs.push({ m: full[m.sym], s })); m.watch.forEach((w) => watch.push({ m, w }));
  });
  ok(good.every((m) => m.signals.length <= 1), "only one callout per market", good.map((m) => m.sym + ":" + m.signals.length).join(" "));
  const fit = (sym) => full[sym].signals.filter((x) => x.passed >= 3 && x.checks.taps && x.days >= 7);
  ok(good.every((m) => m.signals.every((x) => x.passed >= 3 && x.checks.taps && x.taps >= 3 && x.days >= 7)), "only callouts passing 3 of 4 checklist rules, always with 3+ taps and 1+ week of history, are listed");
  ok(sigs.some(({ s }) => s.passed >= 3 && s.checks.taps && s.days < 7), "lines under a week old are found but filtered out");
  ok(sigs.some(({ s }) => s.passed >= 3 && !s.checks.taps), "3-of-4 lines with only 2 taps are found but filtered out");
  ok(sigs.some(({ s }) => s.passed < 3) && sigs.every(({ s }) => s.passed === Object.values(s.checks).filter(Boolean).length && (s.grade === "A+") === (s.passed === 4)), "weaker lines are found but filtered out; A+ = 4/4, B = 3/4");
  ok(good.filter((m) => m.signals.length).every((m) => m.signals[0].t === Math.max(...fit(m.sym).map((x) => x.t))), "the callout shown is the newest one that passes");
  ok(good.filter((m) => m.signals.length).every((m) => (m.signals[0].replaced || 0) === fit(m.sym).length - 1), "it says how many older passing callouts it replaced");
  ok(sigs.length >= 20, "saved data produces callouts", sigs.length);
  ok(["4H", "1H"].every((tf) => sigs.some((x) => x.s.tf === tf)) && sigs.some((x) => x.s.setup === "3-touch break") && sigs.some((x) => x.s.setup === "bounce"), "finds breaks and bounces on both 4-hour and 1-hour charts");
  ok(sigs.every(({ s }) => s.t >= NOW - 9 * 86400), "callouts are from the last 5 trading days");
  ok(sigs.every(({ s }) => ["Monthly", "Weekly", "Daily", "4-hour", "1-hour"].includes(s.lineTF)) && sigs.some(({ s }) => ["Weekly", "Daily"].includes(s.lineTF)), "lines are labeled with the chart they come from, including higher timeframes");
  ok(sigs.every(({ s }) => s.grade !== "A+" || (s.checks.taps && s.checks.angle && s.checks.history && s.taps >= 3 && s.angle < 45 && s.days >= 21)), "A+ means 3+ taps, under 45 degrees and 3+ weeks");
  ok(sigs.every(({ s }) => s.chart.line && (s.setup === "bounce" ? s.chart.line.slope * (s.dir === "long" ? 1 : -1) > 0 : s.chart.line.slope * (s.dir === "long" ? -1 : 1) > 0)), "long breaks are of falling lines, short breaks of rising lines; bounces off the matching line");
  const priced = sigs.filter(({ s }) => s.stop0 != null);
  ok(priced.length >= 10 && priced.every(({ s }) => (s.dir === "long" ? s.stop0 < s.entry : s.stop0 > s.entry) && s.risk > 0), "the starting stop sits on the losing side of entry");
  ok(priced.filter(({ s }) => s.setup !== "bounce").every(({ s }) => s.chart.safety && s.chart.safety.slope * (s.dir === "long" ? 1 : -1) > 0), "break stops sit on the opposite chain's line (the safety line)");
  ok(priced.every(({ s }) => (s.dir === "long" ? s.stop >= s.stop0 : s.stop <= s.stop0)), "the trailing stop only ever tightens");
  const closed = priced.filter(({ s }) => s.status === "closed");
  ok(closed.length >= 3 && closed.every(({ s }) => s.exitR != null && (s.exitHow === "stop order" ? (s.dir === "long" ? s.exitPx <= s.stop + 1e-9 : s.exitPx >= s.stop - 1e-9) : s.exitHow === "close through the line" && (s.dir === "long" ? s.exitPx < s.line : s.exitPx > s.line))), "trades close on the stop order or on a candle closing through the safety line");
  ok(priced.every(({ s }) => (s.dir === "long" ? s.stop < s.line : s.stop > s.line)), "the stop order sits past the safety line, never on it (her rule)");
  ok(closed.filter(({ s }) => s.exitHow === "stop order").length >= 1, "some trades are stopped out by the stop order (it's a real stop, not just a line)");
  ok(sigs.every(({ s }) => ["open", "closed", "too-far", "no-safety"].includes(s.status) && s.target === undefined), "every callout has a known status and no fixed target");
  const aw = scan(load("yahoo_AMZN.json"), load("yahoo_daily_AMZN.json"), { sym: "AMZN", now: AMZN_NOW }).watch;
  ok(aw.length >= 1 && watch.concat(aw.map((w) => ({ w }))).every(({ w }) => w.dist <= 1.5 && w.lineNow > 0 && ["4H", "1H"].includes(w.tf) && w.passed >= 3 && w.checks.taps && w.days >= 7), "watch list only holds callout-quality lines near price (AMZN has one): 3 of 4, 3+ taps, 1+ week; newest lines near price (AAPL has one)");
  ok(sigs.filter(({ s }) => s.mixed).every(({ m, s }) => m.signals.some((y) => y.t === s.t && y.dir !== s.dir)), "mixed-signal flag only where callouts disagree on a candle");
  const gc = full["GC=F"].signals.find((s) => s.tf === "4H" && s.setup === "3-touch break" && s.dir === "long" && s.grade === "A+");
  ok(gc && gc.lineTF === "Daily" && gc.entry === 4057 && gc.status === "too-far", "gold: 4H close above a falling Daily line on Nov 4 (A+), skipped as too far from the safety line", gc && [gc.lineTF, gc.entry, gc.status].join("/"));
  const cl = full["CL=F"].signals.find((s) => s.tf === "1H" && s.dir === "short" && s.lineTF === "Weekly");
  ok(cl && cl.entry === 85.94 && cl.stop0 === 90.78 && cl.stop === 90.46 && cl.status === "too-far", "crude: 1H close below a rising Weekly line; stop order past the safety line (90.78) puts it too far: skipped", cl && [cl.entry, cl.stop0, cl.stop, cl.status].join("/"));
  const allLines = sigs.map(({ s }) => ({ s, ls: s.chart.lines }));
  ok(allLines.every(({ s, ls }) => s.tf !== "4H" || (s.lineTF !== "1-hour" && ls.every((l) => l.tf !== "1-hour"))), "lines found on a 4-hour chart are never called 1-hour");
  const dl = full["GC=F"].signals[0].chart.lines;
  ok(dl.every((l) => (l.t1 - l.t0) / 86400 >= 21 || l.tf !== "Monthly"), "labels still follow line length above the chart's own size");
  ok(sigs.every(({ s }) => s.chart.lines.some((l) => l.action) && (s.setup === "bounce" || !s.chart.safety || s.chart.lines.some((l) => l.safety))), "every callout's line list includes its action and safety lines");
  ok(sigs.every(({ s }) => s.chart.lines.every((l) => ["Monthly", "Weekly", "Daily", "4-hour", "1-hour"].includes(l.tf) && Math.abs(l.P0 + l.slopeX * 0 - l.P0) === 0 && l.now > 0)) && sigs.some(({ s }) => s.chart.lines.some((l) => l.tf === "Monthly")), "line lists go from Monthly lines down to the entry chart");
  ok(sigs.every(({ s }) => s.chart.zoom.length >= 400), "zoomed-out chart gets about 2 years of daily candles");
  ok(sigs.every(({ s }) => { const M2 = s.chart.mid, d = (M2.bars[M2.bars.length - 1][0] - M2.bars[0][0]) / 86400; return M2.bars.length >= 60 && d > 80 && d < 95 && M2.dX > 0; }), "3-month view gets about 3 months of 4-hour candles");
  // Lines line up across views: a 1-hour callout's action line, mapped into the 3-month 4-hour view, passes through the same price at the same time.
  const c1h = sigs.find(({ s }) => s.tf === "1H" && s.chart.lines.some((l) => l.action)).s, al = c1h.chart.lines.find((l) => l.action), M3 = c1h.chart.mid;
  const lastK = M3.bars.length - 1, Xk = M3.X0 + lastK * M3.dX, vMid = al.P0 + al.slopeX * (Xk - al.X0);
  const near = c1h.chart.bars.findIndex((b) => b[0] >= M3.bars[lastK][0]), v1h = c1h.chart.line.p0 + c1h.chart.line.slope * (near - c1h.chart.line.i0);
  ok(Math.abs(vMid - v1h) / v1h < 0.003, "a line sits at the same price in the 1-hour and 3-month views", vMid.toFixed(2) + " vs " + v1h.toFixed(2));
  ok(sigs.every(({ s }) => s.chart.chains.every((e) => e.i1 - e.i0 >= 6)), "charts only draw real trendlines: no short pieces that would look curved");
  ok(sigs.every(({ s }) => s.chart.line.t0 < s.chart.line.t1 && (!s.chart.safety || s.chart.safety.t0 < s.chart.safety.t1)), "every line carries its point A and point B times (for TradingView)");
  // The fast, candle-by-candle lines are the same as rebuilding the chains from scratch.
  const T = require(path.join(ROOT, "api/_trendlines.js"));
  let mism = 0, nChk = 0;
  [["GC", true], ["AAPL", false]].forEach(([f, isF]) => ["4H", "1H"].forEach((tf) => {
    const hb = hourly(load("yahoo_" + f + ".json")).bars, d = hourly(load("yahoo_daily_" + f + ".json")).bars;
    const b = tf === "4H" ? fourHour(hb, isF, NOW) : oneHour(hb, isF, NOW), S = T.setup(d, b, isF, tf);
    for (let i = 0; i <= b.length; i += Math.max(1, Math.floor(b.length / 120))) {
      nChk++; const c = S.chainsBefore(i);
      ["up", "dn"].forEach((k) => { const A = T.active(c[k]), B = S.act[i][k]; if (!((!A && !B) || (A && B && A.a.x === B.a.x && A.b.x === B.b.x))) mism++; });
    }
  }));
  ok(nChk > 400 && mism === 0, "fast candle-by-candle lines match rebuilding the chains (" + nChk + " candles)", mism + " mismatches");

  // Track record: the same rules replayed over the 6 months.
  const recs = good.map((m) => m.record);
  ok(recs.every((r) => r && r.trades >= 5 && r.wins <= r.trades && Math.abs(r.avgR * r.trades - r.totalR) < 0.02 * r.trades + 0.05 && r.worstR <= r.bestR && r.maxDrawdownR <= 0), "every market has a 6-month track record that adds up");
  ok(recs.every((r) => r.nWin + r.nLoss === r.trades && Math.abs(r.winSum - r.lossSum - r.totalR) < 0.05 && r.winHrs >= 0 && r.lossHrs >= 0), "wins and losses add up to the trades and the total R");
  ok(recs.every((r) => r.recent.every((x, k, a) => k === a.length - 1 || a[k + 1].out <= x.t)), "one position per market: each trade ends before the next begins");
  ok(recs.every((r) => r.recent.every((x) => ["safety line", "replaced"].includes(x.how))), "trades end on the safety line or when a newer callout replaces them");
  const clr = M.find((m) => m.sym === "CL=F").record;
  ok(clr.trades === 32 && clr.totalR === 45.54, "crude's 6 months: 32 trades, +45.54R", clr.trades + " / " + clr.totalR);
  ok(recs.every((r) => Object.values(r.bySetup).reduce((a, b) => a + b.trades, 0) === r.trades) && recs.some((r) => r.bySetup.retest), "track record splits trades by setup (break, break & retest, bounce)");
  // Break & retest: found after a break, same line, entered later on a candle that touched the line from the other side.
  const rt = sigs.filter(({ s }) => s.setup === "break & retest");
  ok(rt.length >= 1 && rt.every(({ s }) => s.chart.line && s.chart.line.slope * (s.dir === "long" ? -1 : 1) > 0), "break & retest setups are found, on the line that was broken");
  // Her optional take-profit: past both entry and price, in the trade's direction, at a level with 2+ touches.
  const tps = [];
  good.forEach((m) => full[m.sym].signals.filter((x) => x.status === "open" && x.tp).forEach((x) => tps.push({ m: full[m.sym], s: x })));
  ok(tps.length >= 1 && tps.every(({ m, s }) => s.tp.touches >= 2 && s.tp.r > 0 && (s.dir === "long" ? s.tp.price > s.entry && s.tp.price > m.price : s.tp.price < s.entry && s.tp.price < m.price)), "optional take-profit sits past entry and price, at a level price turned at 2+ times", JSON.stringify(tps.map((x) => x.s.tp)));
  const def = await tradesApi("/api/trades");
  ok(def.body.markets.map((m) => m.sym).join() === "MGC=F,MCL=F" && def.body.markets.every((m) => m.kind === "futures"), "default futures are Micro Gold and Micro Crude only", def.body.markets.map((m) => m.sym).join());
  ok(def.body.markets[0].pointValue === 10 && def.body.markets[1].pointValue === 100, "micro contract values: gold $10, crude $100 per 1.00");
  ok(JSON.stringify(M.find((m) => m.sym === "MGC=F").signals.map((x) => x.t)) === JSON.stringify(M.find((m) => m.sym === "GC=F").signals.map((x) => x.t)), "Micro Gold callouts match gold's chart");
  const t0 = Date.now(), a1 = scan(load("yahoo_GC.json"), load("yahoo_daily_GC.json"), { now: NOW }), ms = Date.now() - t0;
  ok(JSON.stringify(a1.signals) === JSON.stringify(scan(load("yahoo_GC.json"), load("yahoo_daily_GC.json"), { now: NOW }).signals), "same data gives the same callouts");
  ok(ms < 3000, "one futures market scans in under 3 seconds", ms + "ms");
  // The page test also gets AMZN, a real stock with a callout-quality line near price.
  const amzn = { ...scan(load("yahoo_AMZN.json"), load("yahoo_daily_AMZN.json"), { sym: "AMZN", now: AMZN_NOW }), sym: "AMZN" };
  return { ...api.body, markets: api.body.markets.concat([amzn]) };
}

function full_aapl_record() {
  return require(path.join(ROOT, "api/_trendlines.js")).scan(load("yahoo_AMZN.json"), load("yahoo_daily_AMZN.json"), { sym: "AMZN", now: AMZN_NOW }).record;
}

async function scanTests() {
  console.log("Stock scan");
  const U = require(path.join(ROOT, "api/scan.js")).UNIVERSE;
  // Every stock gets AMZN's saved charts except two that fail, like a delisted ticker would.
  const t0 = Date.now(), r = await call("api/scan.js", "/api/scan", fakeYahoo((s) => (["NIO", "PDD"].includes(s) ? null : "AMZN")), AMZN_NOW * 1000), ms = Date.now() - t0;
  const B = r.body;
  ok(U.length >= 100 && new Set(U).size === U.length, "scan list has 100+ different stocks and ETFs", U.length);
  ok(r.status === 200 && B.scanned === U.length - 2 && B.failed.sort().join() === "NIO,PDD", "scan counts what it scanned and names what failed", B.scanned + " " + B.failed);
  ok(B.markets.length === U.length - 2 && B.markets.every((m) => m.kind === "stocks" && U.includes(m.sym) && m.signals.length + m.watch.length > 0 && m.signals.length <= 1), "scan returns only stocks with a setup, one callout each, under their own symbols");
  ok(ms < 30000, "full scan runs in under 30 seconds of work", ms + "ms");
  const ar = full_aapl_record();
  ok(B.record && B.record.stocks === U.length - 2 && B.record.trades === ar.trades * (U.length - 2) && Math.abs(B.record.totalR - ar.totalR * (U.length - 2)) < 0.01 && B.record.best.length === 5 && B.record.worst.length === 5 && Math.abs(B.record.winSum - ar.winSum * (U.length - 2)) < 0.05 && B.record.nWin === ar.nWin * (U.length - 2),
    "stock track record adds up every scanned stock (with best and worst 5)", JSON.stringify({ stocks: B.record.stocks, trades: B.record.trades, totalR: B.record.totalR }));
  return B;
}

const OPT_NOW = Date.UTC(2026, 10, 10, 1); // when the saved AAPL chain was taken
async function optionsTests() {
  console.log("Option contracts");
  const { pick } = require(path.join(ROOT, "api/_options.js"));
  const chain = JSON.parse(fs.readFileSync(fx("cboe_AAPL.json")));
  const L = pick(chain, { dir: "long", entry: 350, stop: 340, target: 375 }, OPT_NOW), S = pick(chain, { dir: "short", entry: 350, stop: 358, target: null }, OPT_NOW);
  ok(L.contracts.length === 1 && S.contracts.length === 1, "one contract (the best) for a long and for a short", L.contracts.length + "/" + S.contracts.length);
  ok(L.contracts.every((c) => c.type === "call" && c.delta > 0) && S.contracts.every((c) => c.type === "put" && c.delta < 0), "calls for longs, puts for shorts");
  const all = L.contracts.concat(S.contracts);
  ok(all.every((c) => c.dte >= 21 && c.dte <= 75), "21-75 days to expiry");
  ok(all.every((c) => Math.abs(c.delta) >= 0.45 && Math.abs(c.delta) <= 0.75), "delta 0.45-0.75");
  ok(all.every((c) => c.oi >= 100 && c.spreadPct <= 10 && c.bid > 0 && c.ask > c.bid), "open interest 100+, spread under 10%");
  ok(all.every((c) => typeof c.theta === "number" && c.theta < 0 && typeof c.volume === "number"), "contracts include theta (time decay per day) and volume");
  ok(all.every((c) => c.atTargetPct > 0 && c.atStopPct < 0 && c.cost === Math.round(c.mid * 100)), "gains at target, loses at stop, cost is 100 shares");
  ok(S.target === 334 && S.targetIsDefault, "no target on the callout: uses 2R");
  ok(L.contracts[0].contract === "AAPL261218C00350000", "AAPL long 350 to 375: best pick is the Dec 18 350 call", L.contracts[0].contract);
  const none = pick(chain, { dir: "long", entry: 350, stop: 340, target: 375 }, Date.UTC(2027, 5, 1));
  ok(none.contracts.length === 0 && /21-75 days/.test(none.note), "explains when nothing qualifies");

  const handler = require(path.join(ROOT, "api/options.js")), saved = global.fetch, realNow = Date.now;
  const call = (url) => new Promise((r) => { const res = { statusCode: 200, setHeader() {}, end(b) { r({ status: res.statusCode, body: JSON.parse(b) }); } }; handler({ method: "GET", url }, res); });
  global.fetch = async (u) => (String(u).includes("/AAPL.json") ? { ok: true, status: 200, json: async () => chain } : { ok: false, status: 403 });
  Date.now = () => OPT_NOW;
  const a = await call("/api/options?sym=AAPL&dir=long&entry=350&stop=340&target=375");
  const f = await call("/api/options?sym=GC%3DF&dir=long&entry=4000&stop=3900");
  const z = await call("/api/options?sym=ZZZZ&dir=long&entry=10&stop=9");
  global.fetch = saved; Date.now = realNow;
  ok(a.status === 200 && a.body.contracts.length === 1, "options API returns the best contract");
  ok(f.status === 400 && /futures/.test(f.body.error), "options API turns away futures");
  ok(z.status === 404 && /No listed options/.test(z.body.error), "options API explains a stock with no options");
  return a.body;
}

// Opens every collapsed list (Live, Skipped) on the Callouts tab.
async function openFolds(page) {
  // Each click redraws the list, so click the first closed one until none are left.
  for (let n = 0; n < 5 && (await page.locator("[data-fold][aria-expanded=false]").count()); n++) await page.locator("[data-fold][aria-expanded=false]").first().click();
}

async function pageTests(browser, body, optBody, scanBody) {
  console.log("Page");
  // The saved futures have no live callout at that moment, so make Micro Gold's newest one live, fired an hour ago.
  body = JSON.parse(JSON.stringify(body));
  Object.assign(body.markets.find((m) => m.sym === "MGC=F").signals[0], { status: "open", nowR: 0.1, liveThrough: false, t: NOW - 3600 });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }), errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  let scanJson = { at: Date.now(), scanned: 108, failed: ["NIO", "PDD"], markets: [] };
  await page.route("**/api/scan", (r) => r.fulfill({ json: scanJson }));
  await page.clock.setFixedTime(NOW * 1000); // the browser's "now" = when the saved data was taken
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent), null, { timeout: 8000 }).catch(() => {});
  const futR = body.markets.filter((m) => m.kind === "futures" && m.record && m.record.trades).reduce((a, m) => a + m.record.totalR, 0);
  const trk = (await page.locator(".trk").textContent());
  ok(await page.evaluate(() => document.getElementById("out").firstElementChild.classList.contains("trk")), "the track record box is at the top");
  ok(!trk.includes("Overall") && !trk.includes("stocks") && trk.includes("Track record: futures") && trk.includes((futR >= 0 ? "+" : "−") + Math.abs(futR).toFixed(1) + "%") && trk.includes("at 1% risk per trade"), "futures tab shows only the futures ROI: total % at 1% risk per trade", trk.slice(0, 160));
  await page.click("[data-fold=track]");
  const fr = body.markets.filter((m) => m.kind === "futures" && m.record && m.record.trades).map((m) => m.record), sum = (k) => fr.reduce((a, r) => a + r[k], 0);
  const wlTxt = await page.locator(".trk .wl").first().textContent();
  ok((await page.locator(".trk .wl", { hasText: "By setup" }).count()) === 1, "Details also shows results by setup");
  ok(wlTxt.includes("Average win +" + (sum("winSum") / sum("nWin")).toFixed(1) + "R") && wlTxt.includes("average loss −" + (sum("lossSum") / sum("nLoss")).toFixed(1) + "R") &&
    wlTxt.includes((sum("winSum") / sum("nWin") / (sum("lossSum") / sum("nLoss"))).toFixed(1) + "× bigger than losses") && wlTxt.includes("For every $1 lost, $" + (sum("winSum") / sum("lossSum")).toFixed(2)) && wlTxt.includes("Winners held"),
    "Details shows average win and loss, how much bigger wins are, $ made per $1 lost, and time held", wlTxt);
  ok((await page.locator(".trk .trr").count()) === body.markets.filter((m) => m.kind === "futures" && m.record && m.record.trades).length && (await page.locator(".trk", { hasText: "How this is worked out" }).count()) === 1, "Details lists each futures market and explains the replay");
  await page.click("[data-fold=track]");
  ok((await page.locator("[data-fold=live][aria-expanded=true]").count()) === 1 && (await page.locator(".gi.row").count()) === 0, "Live callouts starts open, with no green get-in boxes");
  await page.click("[data-fold=live]");
  ok((await page.locator("[data-fold=live][aria-expanded=false]").count()) === 1 && (await page.evaluate(() => localStorage.getItem("tl:liveOpen"))) === "false", "its button closes it, and the choice is remembered");
  await page.click("[data-fold=live]");
  await openFolds(page);
  ok((await page.locator("#kinds button").allTextContents()).join() === "Futures,Stocks", "only Futures and Stocks chips (no All)");
  ok((await page.locator("[data-fold=done]").count()) === 0 && !/Finished/.test(await page.locator("#out").textContent()), "no Finished list (closed trades only count in the track record)");
  ok((await page.locator(".cl .note", { hasText: "Size:" }).count()) === 0, "no position size until you enter an account size");
  await page.fill("#acct", "10,000"); await page.fill("#riskP", "1"); await page.click("#sizeF button");
  const mgcLive = body.markets.find((m) => m.sym === "MGC=F").signals[0], perC = mgcLive.risk * 10, nC = Math.floor(100 / perC);
  const sizeTxt = await page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first().locator(".note", { hasText: "Size:" }).textContent();
  ok(nC >= 1 ? sizeTxt.includes("Size: " + nC + " micro contract") : sizeTxt.includes("more than your 1%"), "position size: $10,000 at 1% sets how many micro contracts", sizeTxt + " (risk/contract $" + perC.toFixed(0) + ")");
  ok((await page.evaluate(() => localStorage.getItem("tl:acct"))) === "10000", "account size is saved on the phone");
  ok((await page.locator(".cl .gr", { hasText: "Stop order now (trailing)" }).count()) >= 1 && (await page.locator(".cl .note", { hasText: "just past the safety line" }).count()) >= 1, "live cards show the stop order to set, just past the safety line");
  const fut = await page.locator(".cl .st", { hasText: "GET IN NOW" }).allTextContents();
  ok(fut.length >= 1 && fut.every((x) => /GET IN NOW: (BUY|SELL) [A-Z]+ near/.test(x)), "futures cards say GET IN NOW: BUY or SELL (no calls or puts)", fut.join(","));
  ok((await page.locator(".cl").count()) >= 2, "callout cards render", await page.locator(".cl").count());
  ok((await page.locator(".cl .tag", { hasText: /^(A\+ · 4|B · 3)\/4$/ }).count()) === (await page.locator(".cl").count()), "every card shows how many checklist rules it passes (3/4 or 4/4)");
  ok((await page.locator(".cl .tag", { hasText: /^(4H|1H)$/ }).count()) === (await page.locator(".cl").count()), "every card says which chart it's on (4H or 1H)");
  ok((await page.locator(".cl", { hasText: /(Monthly|Weekly|Daily|4-hour|1-hour)<?\/?b?>? ?line|line \(from/ }).count()) >= 1, "cards name the line's timeframe");
  ok(/no data for ZZZ/.test(await page.textContent("#sub")), "header names symbols with no data");
  ok(/scanned 108 stocks/.test(await page.textContent("#sub")), "header shows how many stocks were scanned");
  ok(asked.length && asked[0].includes("s=MGC=F,MCL=F"), "page asks for Micro Gold and Micro Crude", asked[0]);
  const syms = await page.locator(".cl .sym").allTextContents();
  ok(syms.includes("MGC") && !syms.some((x) => x.includes("=F")), "futures show as MGC and MCL, without Yahoo's =F", syms.join(","));
  ok(!/=F/.test(await page.textContent("#mkList")), "your-markets list shows MGC, MCL without =F");
  ok(/Per micro contract: starting risk \$[\d,]+.*\(\$10 per 1\.00 move\)/.test(await page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first().textContent()), "Micro Gold callout shows risk per contract");
  // TradingView: a link on every card to the same market and chart, and the lines as points and a Pine Script.
  ok((await page.locator("a[href*='tradingview.com']").count()) === 0, "no TradingView links on the cards");
  const mgc = page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first();
  await mgc.locator("[data-tvl]").click();
  const pine = await page.locator(".tvp textarea").first().inputValue(), mgcSig = body.markets.find((m) => m.sym === "MGC=F").signals[0];
  ok(pine.startsWith("//@version=5") && pine.includes("line.new(" + mgcSig.chart.line.t0 * 1000 + ",") && pine.includes("extend=extend.right") && (await page.locator(".tvp .note", { hasText: "Action line" }).count()) === 1,
    "lines panel lists point A/B and a Pine Script with the exact action line", pine.slice(0, 200));
  ok((await page.locator(".cl svg").count()) === 0, "opening the lines panel doesn't open the chart");
  await mgc.locator("[data-tvl]").click();
  ok((await page.locator(".tvp").count()) === 0, "lines panel closes again");
  await page.locator(".cl").first().click();
  ok((await page.locator(".cl svg line").count()) > 50, "tapping a callout opens its chart");
  ok((await page.locator(".cl .lns .lnr").count()) >= 3 && (await page.locator(".cl .lns .lnr.now").count()) === 1 && (await page.locator(".cl .lns .tag", { hasText: "action" }).count()) === 1, "under the chart: every line on the market, with price now and the action line marked");
  ok((await page.locator(".cl .zsw .btn").allTextContents()).length === 3, "three chart choices: the callout's chart, 3 months, 2 years");
  await page.click(".cl [data-mode=zoom]");
  ok((await page.locator(".cl svg[aria-label^='Daily chart, 2 years']").count()) === 1, "2 years: daily candles with every line");
  await page.click(".cl [data-mode=mid]");
  ok((await page.locator(".cl svg[aria-label^='4-hour chart, 3 months']").count()) === 1, "3 months: 4-hour candles with the Daily and 4-hour lines");
  await page.click(".cl [data-mode='']");
  ok((await page.locator(".cl svg[aria-label*='3 months'], .cl svg[aria-label*='2 years']").count()) === 0 && (await page.locator(".cl svg").count()) === 1, "and back to the callout's chart; switching doesn't close it");
  ok((await page.locator(".cl svg line[stroke='#1fa463']").count()) + (await page.locator(".cl svg line[stroke='#d64545']").count()) >= 2, "the chart draws her green rising and red falling lines");
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const awayTxt = await page.locator(".c", { has: page.locator(".sym", { hasText: /^AMZN$/ }) }).first().locator(".wl2 span", { hasText: "away" }).first().textContent();
  const aw0 = body.markets.find((m) => m.sym === "AMZN"), wantAway = "$" + Math.abs(aw0.price - aw0.watch[0].lineNow).toFixed(2) + " away · " + aw0.watch[0].dist + " ATR";
  ok(awayTxt.trim() === wantAway, "watch list shows the distance in price and in ATR (AMZN)", awayTxt + " vs " + wantAway);
  // Lines about to become A+ get a tag and sort right after A+ lines.
  const soon = await page.evaluate(() => [soonAplus({ grade: "B", days: 18, checks: { taps: true, angle: true, history: false } }), soonAplus({ grade: "B", days: 10, checks: { taps: true, angle: true, history: false } }),
    soonAplus({ grade: "B", days: 19, checks: { taps: true, angle: false, history: false } }), soonAplus({ grade: "A+", days: 30, checks: { taps: true, angle: true, history: true } })]);
  ok(JSON.stringify(soon) === "[3,null,null,null]", "\"A+ in N days\" only for lines missing just the 3 weeks, within a week of it", JSON.stringify(soon));
  const wb = JSON.parse(JSON.stringify(body)), am = wb.markets.find((m) => m.sym === "AMZN");
  am.watch = [{ ...am.watch[0], grade: "B", passed: 3, days: 17, checks: { taps: true, spacing: true, angle: true, history: false }, dist: 0.2, key: "x1", lineTF: "Daily" },
    { ...am.watch[0], grade: "B", passed: 3, days: 9, checks: { taps: true, spacing: true, angle: true, history: false }, dist: 0.1, key: "x2", lineTF: "4-hour" }, am.watch[0]];
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: wb }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const order = await page.locator("#out article.c").evaluateAll((els) => els.map((e) => (e.textContent.includes("A+ in 4 days") ? "soon" : /A\+ · 4\/4/.test(e.textContent) ? "A+" : "B")));
  ok(order.slice(0, 3).join() === "A+,soon,B" && (await page.locator("#out .tag", { hasText: "A+ in 4 days" }).count()) === 1, "watch list: A+ first, then \"A+ in 4 days\", then other B lines", order.join());
  // Stocks watch list: top 5, then a button for the rest. Futures: no button.
  const many = JSON.parse(JSON.stringify(body)), amz = many.markets.find((m) => m.sym === "AMZN");
  amz.watch = Array.from({ length: 8 }, (_, k) => ({ ...amz.watch[0], key: "k" + k, dist: 0.1 * (k + 1) }));
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: many }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const hs = await page.locator("#out article.wc").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  ok(hs.length === 5 && hs.every((h) => h < 140), "watch-list boxes are compact (under 140px tall on a phone)", hs.map(Math.round).join(","));
  ok((await page.locator("#out article.wc .wl3.warn").count()) === 0 && (await page.locator("#out article.wc .ck").count()) === 0, "A+ watch boxes show no \"Missing\" note and no long checklist");
  ok((await page.locator("#out article.c").count()) === 5 && (await page.locator("[data-wall]").textContent()) === "Show all 8", "stocks watch list shows the top 5 with a \"Show all 8\" button");
  await page.click("[data-wall]");
  ok((await page.locator("#out article.c").count()) === 8 && (await page.locator("[data-wall]").textContent()).startsWith("Show only the top 5"), "Show all opens the rest, and the button shrinks it back");
  await page.click("[data-wall]");
  ok((await page.locator("#out article.c").count()) === 5, "back to 5");
  await page.click("[data-k=futures]");
  ok((await page.locator("[data-wall]").count()) === 0, "futures watch list has no show-all button");
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const wl = page.locator(".c", { has: page.locator(".sym", { hasText: /^AMZN$/ }) }).first();
  await wl.locator("[data-tvl]").click();
  ok((await page.locator(".tvp textarea").inputValue()).includes("line.new("), "watch list lines can be copied for TradingView");
  await page.click("[data-k=futures]");
  await page.click("[data-tab=rules]");
  ok((await page.locator("text=Top-down analysis").count()) >= 1 && (await page.locator("text=previous point B is new point A").count()) >= 1, "rules tab explains her top-down steps");
  const rulesTxt = await page.locator(".rules").textContent();
  ok(["Break & retest", "Bounce", "just past", "1–2%", "Commit to one timeframe", "Journal every trade", "Practice first", "Redraw daily"].every((x) => rulesTxt.includes(x)), "rules tab covers her whole system: setups, stop past the line, sizing, one timeframe, journaling, practice, upkeep");
  ok((await page.locator(".rules .tag", { hasText: "automatic" }).count()) >= 7 && (await page.locator(".rules .tag", { hasText: /^you$/ }).count()) >= 3, "each step says whether it's automatic or yours");
  ok((await page.locator("text=How the computer does it").count()) === 0 && (await page.locator("#out >> text=Option contracts").count()) === 0, "rules tab has no computer or options sections");
  await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  await openFolds(page);
  ok((await page.locator(".cl .sym", { hasText: /^(M?GC|MCL|CL|PL|YM)$/ }).count()) === 0 && (await page.locator(".trk", { hasText: "Track record: stocks" }).count() + await page.locator(".gi.none", { hasText: "stocks" }).count()) >= 1, "Stocks filter hides futures and shows the stocks view");
  await page.fill("#addIn", "amd"); await page.press("#addIn", "Enter"); await page.waitForTimeout(300);
  ok(asked.some((u) => u.includes("AMD")), "adding a symbol rescans with it");
  await page.fill("#addIn", "gc"); await page.press("#addIn", "Enter"); await page.waitForTimeout(300);
  ok(asked.some((u) => /s=[^&]*GC=F/.test(u) && /,GC=F/.test(u)), "typing GC adds the gold futures contract (GC=F)", asked[asked.length - 1]);
  await page.setViewportSize({ width: 360, height: 800 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll on a small phone");
  const man = await page.evaluate(async () => { const r = await fetch("/manifest.json"); const j = await r.json(); const ic = await Promise.all(j.icons.map((i) => fetch(i.src).then((x) => x.ok))); return { name: j.name, display: j.display, icons: ic.every(Boolean) }; });
  ok(man.name === "Trade Finder" && man.display === "standalone" && man.icons, "home-screen app: named Trade Finder, opens without the address bar, icons load", JSON.stringify(man));
  ok((await page.getAttribute("meta[name=apple-mobile-web-app-title]", "content")) === "Trade Finder", "iPhone home-screen label is Trade Finder");
  // Stocks found by the scan show up next to your own symbols.
  scanJson = { ...scanBody, markets: scanBody.markets.filter((m) => m.sym === "NVDA") }; // NVDA here carries AMZN's charts
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent)); await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  const sr = scanBody.record, strk = await page.locator(".trk").textContent();
  ok(!strk.includes("Overall") && !strk.includes("futures"), "stocks tab shows only the stocks ROI");
  ok(strk.includes("Track record: stocks") && strk.includes(sr.trades + " trades") && strk.includes((sr.totalR >= 0 ? "+" : "−") + Math.abs(sr.totalR).toFixed(1) + "%"), "stocks track record shows all scanned stocks added up", strk.slice(0, 160));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent)); await page.click("[data-k=stocks]");
  await page.click("[data-tab=watch]");
  ok((await page.locator(".c .sym", { hasText: "NVDA" }).count()) >= 1, "stocks from the scan appear under Stocks (on the Watch list)");
  await page.click("[data-tab=calls]");
  scanJson = { at: Date.now(), scanned: 108, failed: [], markets: [] };

  // A live stock callout gets an options button; the panel loads contracts and doesn't flip the chart.
  const b2 = JSON.parse(JSON.stringify(body)), stock = b2.markets.find((m) => m.sym === "TEST");
  const sig = stock.signals.find((x) => x.stop0 != null) || stock.signals[0]; sig.status = "open"; sig.nowR = 0.1; sig.liveThrough = false; sig.t = NOW - 3600; // fired an hour ago
  if (sig.stop0 == null) Object.assign(sig, { stop0: sig.entry * 0.97, stop: sig.entry * 0.97, risk: sig.entry * 0.03, dir: "long" });
  await page.unroute("**/api/trades**");
  await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  let optAsk = "";
  await page.route("**/api/options**", (r) => { optAsk = decodeURIComponent(r.request().url()); r.fulfill({ json: optBody }); });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-k=stocks]");
  ok((await page.locator(".cl .st", { hasText: /GET IN NOW: BUY (CALL|PUT) TEST \(stock near/ }).count()) === 1, "the card itself says GET IN NOW: BUY CALL/PUT");
  const late = JSON.parse(JSON.stringify(b2)); late.markets.find((m) => m.sym === "TEST").signals[0].nowR = 1.4;
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: late }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  ok((await page.locator(".gi.none").count()) === 1 && (await page.locator(".cl .sym", { hasText: /^TEST$/ }).count()) === 0, "a live trade already 1.4R past entry is no longer listed");
  const old2 = JSON.parse(JSON.stringify(b2)); Object.assign(old2.markets.find((m) => m.sym === "TEST").signals[0], { t: NOW - 2 * 86400 });
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: old2 }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  ok((await page.locator(".gi.none").count()) === 1 && (await page.locator(".cl .sym", { hasText: /^TEST$/ }).count()) === 0, "a live trade from 2 days ago is no longer listed (still counted in the track record)");
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await openFolds(page);
  ok((await page.locator("[data-opt]").count()) === 1, "live stock callout has an options button");
  ok((await page.locator(".cl", { hasText: "GC=F" }).locator("[data-opt]").count()) === 0, "futures callouts have no options button");
  await page.click("[data-opt]"); await page.waitForSelector(".oc", { timeout: 5000 }).catch(() => {});
  ok((await page.locator(".oc").count()) === 1 && (await page.locator(".oc .tag", { hasText: "Best pick" }).count()) === 1, "only the best contract shows, marked Best pick");
  ok(/sym=TEST/.test(optAsk) && optAsk.includes("dir=" + sig.dir) && optAsk.includes("stop=" + sig.stop0) && !/target=/.test(optAsk), "options request carries the direction and starting stop (no target: 2R)", optAsk);
  const box = await page.locator(".oc").first().textContent();
  ok(["Bid / Ask $", "Volume ", "Open interest ", "Delta ", "Theta ", "/day)", "Implied volatility ", "%"].every((x) => box.includes(x)), "each contract shows bid/ask, volume, open interest, delta, theta and implied volatility", box);
  ok((await page.locator(".oc .on").first().textContent()).includes("Dec 18, 26 $350 Call"), "contract name reads like a broker's", await page.locator(".oc .on").first().textContent());
  ok((await page.locator(".cl svg").count()) === 0, "opening options doesn't open the chart");
  await page.click(".op .oc"); 
  ok((await page.locator(".cl svg").count()) === 0, "tapping inside the options panel doesn't open the chart");
  await page.click("[data-opt]");
  ok((await page.locator(".oc").count()) === 0, "options button hides the panel again");
  ok(!errors.length, "page has no errors", errors.join(" | "));
  await page.close();
}

(async () => {
  let body;
  try { body = await scannerTests(); } catch (e) { ok(false, "scanner tests crashed", e.message); }
  let scanBody;
  try { scanBody = await scanTests(); } catch (e) { ok(false, "scan tests crashed", e.message); }
  let optBody;
  try { optBody = await optionsTests(); } catch (e) { ok(false, "options tests crashed", e.message); }
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch();
  try { if (body && optBody && scanBody) await pageTests(browser, body, optBody, scanBody); } catch (e) { ok(false, "page tests crashed", e.message); }
  await browser.close(); server.kill();
  console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
