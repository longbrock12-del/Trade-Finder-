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
const AMZN_NOW = 1794340000;
let lookBody = null; // AAPL looked up, for the page test
let amzWChart = null; // AMZN with watch-line charts, for the page test
const EARN = { earnings: { AMZN: { date: "2026-11-12", when: "after close" } } }; // AMZN reports the day after the saved data
let NEWS = { events: [] }; // filled by the news check, then served to the page tests // the AMZN data was saved later (Nov 10 2026) // when the saved data was taken (Nov 9 2026, 5:48 PM New York), so the forming candle stays forming

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

  const api = await tradesApi("/api/trades?s=PL=F,CL=F,GC=F,YM=F,TEST,ZZZ,bad%20sym,MGC=F&tf=both");
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
  // Chart setting: 4-hour by default; ?tf=1H or both changes it.
  const d4 = def.body.markets[0], dB = (await tradesApi("/api/trades?tf=both")).body.markets[0], d1 = (await tradesApi("/api/trades?tf=1H")).body.markets[0];
  const r4 = T.scan(load("yahoo_GC.json"), load("yahoo_daily_GC.json"), { sym: "MGC=F", all: true, now: NOW, tfs: ["4H"] });
  ok(d4.signals.every((x) => x.tf === "4H") && d4.watch.every((w) => w.tf === "4H") && r4.signals.every((x) => x.tf === "4H"), "by default everything comes from the 4-hour chart");
  const amzW = (await call("api/trades.js", "/api/trades?s=AMZN&tf=both&wchart=1", fakeYahoo((s) => (s === "AMZN" ? "AMZN" : null)), AMZN_NOW * 1000)).body.markets[0];
  const amzN = (await call("api/trades.js", "/api/trades?s=AMZN&tf=both", fakeYahoo((s) => (s === "AMZN" ? "AMZN" : null)), AMZN_NOW * 1000)).body.markets[0];
  amzWChart = amzW;
  const wc = amzW.watch[0] && amzW.watch[0].chart;
  ok(wc && wc.bars.length > 50 && wc.line && wc.line.t0 === amzW.watch[0].line.t0 && Array.isArray(wc.lines) && wc.lines.some((l) => l.action) && wc.zoom.length > 100 && wc.mid.bars.length > 50, "?wchart=1: a watch line gets the same chart a callout gets (its line thick, every line, zoom views)", amzW.watch.length);
  ok(amzN.watch.length && amzN.watch.every((w) => !w.chart && !w._ln), "no watch charts unless asked (the page stays small)");
  const lk = (await call("api/trades.js", "/api/trades?s=AAPL&tf=4H&look=1", fakeYahoo((s) => (s === "AAPL" ? "AAPL" : null)))).body.markets[0];
  ok(lk.look && lk.look.chart && lk.look.chart.bars.length > 50 && lk.look.chart.lines.length >= 2 && lk.look.chart.taps.length === lk.look.taps && lk.look.lineNow > 0 && amzN.look === undefined, "?look=1: any symbol gets a 4-hour chart around its nearest line, with every line and its taps", lk.look && JSON.stringify({ ...lk.look, chart: 0 }));
  lookBody = lk;
  // Taps: every one the line's count includes is in the chart data (older ones too), and each is a real touch:
  // the candle's low (rising line) or high (falling line) within 0.3 ATR of the line.
  let tapN = 0, tapBad = 0, tapMis = 0, tapNear = 0, tapNearBad = 0;
  [["MGC=F", "GC", NOW, true], ["MCL=F", "CL", NOW, true], ["PL=F", "PL", NOW, true], ["AAPL", "AAPL", NOW, false], ["AMZN", "AMZN", AMZN_NOW, false]].forEach(([sym, f, now, fut]) => {
    const mk = T.scan(load("yahoo_" + f + ".json"), load("yahoo_daily_" + f + ".json"), { sym, now, all: true, watchCharts: true, tfs: ["4H"] });
    const dl = T.hourly(load("yahoo_daily_" + f + ".json")).bars, b4 = T.fourHour(T.hourly(load("yahoo_" + f + ".json")).bars, fut, now), dA = T.atr(dl), A4 = T.atr(b4);
    mk.signals.filter((x) => x.chart).map((x) => [x, x.chart]).concat(mk.watch.map((w) => [w, w.chart])).forEach(([x, c]) => {
      if (c.taps.length !== x.taps) tapMis++;
      c.taps.forEach((q) => {
        tapN++;
        let i = b4.findIndex((b) => b.t === q.t), bar = b4[i], a = A4[i];
        if (i < 0) { i = dl.findIndex((b) => b.t === q.t); bar = dl[i]; a = dA[i]; }
        if (!bar || Math.abs((c.line.slope > 0 ? bar.l : bar.h) - q.p) / a > 0.3001) tapBad++;
        const short = c.line.slope > 0 ? bar.l - q.p : q.p - bar.h; // > 0: the wick stopped short of the line
        if (q.near !== short > 0.1 * a + 0.006) { if (Math.abs(short - 0.1 * a) > 0.02) tapNearBad++; }
        if (q.near) tapNear++;
      });
    });
  });
  ok(tapN > 30 && !tapBad && !tapMis, "every tap counted is in the chart (older ones too) and really touches the line", tapN + " taps, " + tapBad + " off, " + tapMis + " count mismatches");
  ok(!tapNearBad && tapNear > 0 && tapNear < tapN, "taps are marked near miss only when the wick stopped more than 0.1 ATR short of the line", tapNear + " near of " + tapN + ", " + tapNearBad + " wrong");
  ok(d1.signals.every((x) => x.tf === "1H") && d1.record.trades !== d4.record.trades && dB.record.trades === M.find((m) => m.sym === "MGC=F").record.trades, "?tf=1H and ?tf=both switch the chart (and the track record)", [d4.record.trades, d1.record.trades, dB.record.trades].join("/"));
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
  return require(path.join(ROOT, "api/_trendlines.js")).scan(load("yahoo_AMZN.json"), load("yahoo_daily_AMZN.json"), { sym: "AMZN", now: AMZN_NOW, tfs: ["4H", "1H"] }).record;
}

async function scanTests() {
  console.log("Stock scan");
  const U = require(path.join(ROOT, "api/scan.js")).UNIVERSE;
  // Every stock gets AMZN's saved charts except two that fail, like a delisted ticker would.
  const t0 = Date.now(), r = await call("api/scan.js", "/api/scan?tf=both", fakeYahoo((s) => (["NIO", "PDD"].includes(s) ? null : "AMZN")), AMZN_NOW * 1000), ms = Date.now() - t0;
  const B = r.body;
  ok(U.length >= 100 && new Set(U).size === U.length, "scan list has 100+ different stocks and ETFs", U.length);
  ok(r.status === 200 && B.scanned === U.length - 2 && B.failed.sort().join() === "NIO,PDD", "scan counts what it scanned and names what failed", B.scanned + " " + B.failed);
  ok(B.markets.length === U.length - 2 && B.markets.every((m) => m.kind === "stocks" && U.includes(m.sym) && m.signals.length + m.watch.length > 0 && m.signals.length <= 1), "scan returns only stocks with a setup, one callout each, under their own symbols");
  ok(ms < 30000, "full scan runs in under 30 seconds of work", ms + "ms");
  // Test-only rule settings: change the replay, never the normal scan.
  const TL = require(path.join(ROOT, "api/_trendlines.js")), gcArgs = () => [load("yahoo_GC.json"), load("yahoo_daily_GC.json")];
  const base = TL.scan(...gcArgs(), { sym: "MGC=F", now: NOW, tfs: ["4H"] }).record, tight = TL.scan(...gcArgs(), { sym: "MGC=F", now: NOW, tfs: ["4H"], rules: { touch: 0.1 } }).record, after = TL.scan(...gcArgs(), { sym: "MGC=F", now: NOW, tfs: ["4H"] }).record;
  ok(tight.trades < base.trades && after.trades === base.trades && after.totalR === base.totalR, "test settings (?touch=0.1) change the replay, and the normal scan is untouched afterwards", base.trades + " → " + tight.trades + " → " + after.trades);
  const rt = await call("api/scan.js", "/api/scan?touch=0.15&gap=5", fakeYahoo((s) => (["NIO", "PDD"].includes(s) ? null : "AMZN")), AMZN_NOW * 1000);
  ok(rt.status === 200 && rt.body.test.touch === 0.15 && rt.body.test.gap === 5 && rt.body.record && !rt.body.markets && rt.body.scanned === U.length - 2, "/api/scan?touch=&gap= answers with just the test record of every stock", JSON.stringify(rt.body.test));
  ok((await call("api/scan.js", "/api/scan?touch=5", fakeYahoo(() => "AMZN"), AMZN_NOW * 1000)).status === 400, "out-of-range test settings are refused");
  const must = TL.scan(...gcArgs(), { sym: "MGC=F", now: NOW, tfs: ["4H"], rules: { short: 0.05 } }).record;
  ok(must.trades < base.trades && TL.scan(...gcArgs(), { sym: "MGC=F", now: NOW, tfs: ["4H"] }).record.trades === base.trades, "?short=0.05 (taps must actually touch) is a test setting only: fewer trades, normal scan unchanged", base.trades + " → " + must.trades);
  const rk = require(path.join(ROOT, "api/scan.js")).ranks;
  const fakeRecs = Array.from({ length: 14 }, (_, i) => ({ sym: "S" + i, trades: i % 5 === 0 ? 2 : 4, wins: 2, totalR: 7 - i }));
  const top = rk(fakeRecs);
  ok(top.length === 5 && top.map((x) => x.sym).join() === "S1,S2,S3,S4,S6" && top.every((x) => x.trades >= 3 && x.totalR > 0), "respects-trendlines list: best total R first, 3+ trades and positive only, at most 10", top.map((x) => x.sym).join());
  ok(rk(Array.from({ length: 30 }, (_, i) => ({ sym: "T" + i, trades: 5, wins: 3, totalR: 30 - i }))).length === 10, "respects-trendlines list stops at 10");
  const amzRec = B.markets[0].record || {};
  ok(Array.isArray(B.ranks) && B.ranks.length === (amzRec.trades >= 3 && amzRec.totalR > 0 ? 10 : 0), "the scan sends the respects-trendlines list", (B.ranks || []).length + " " + amzRec.totalR);
  // News: big US events (High impact) plus the crude oil inventory report; other countries and holidays left out.
  const cal = load("ff_calendar.json"), nr = await call("api/news.js", "/api/news", async () => ({ ok: true, status: 200, json: async () => cal }));
  // Earnings (Nasdaq calendar): rows for the stocks we scan, with before open / after close.
  const E = require(path.join(ROOT, "api/earnings.js")), ecal = load("nasdaq_earnings.json");
  const ep = E.pick(ecal, "2026-11-12", new Set(["CSCO", "BN", "BNT", "ZZZ"]));
  ok(ep.length === 3 && ep.find((x) => x.sym === "CSCO").when === "after close" && ep.find((x) => x.sym === "BN").when === "before open" && ep.find((x) => x.sym === "BNT").when === "" && ep.every((x) => x.date === "2026-11-12"), "earnings calendar: only our stocks, with before open / after close", JSON.stringify(ep));
  ok(E.days(Date.UTC(2026, 10, 14, 15)).every((d) => ![0, 6].includes(new Date(d + "T12:00:00Z").getUTCDay())) && E.days(Date.UTC(2026, 10, 14, 15))[0] === "2026-11-16", "earnings: looks ahead 2 weeks of weekdays (New York dates)");
  ok(E.pick({}, "2026-11-12", new Set(["CSCO"])).length === 0, "earnings: a bad calendar day gives no rows (no crash)");
  ok(nr.status === 200 && nr.body.events.map((e) => e.title).join("|") === "Core CPI m/m|CPI m/m|Crude Oil Inventories|PPI m/m" && nr.body.events.find((e) => e.crude).title === "Crude Oil Inventories",
    "news keeps big US releases and the crude oil inventory report (marked crude-only)", nr.body.events.map((e) => e.title).join("|"));
  const nf = await call("api/news.js", "/api/news", async () => ({ ok: false, status: 500 }));
  ok(nf.status === 200 && nf.body.events.length === 0, "if the calendar is down, the site just shows no news warnings");
  NEWS = nr.body;
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

// Opens the collapsed "Trades to get into now" list on the Callouts tab, if it's closed.
async function openFolds(page) {
  // Each click redraws the list, so click the first closed one until none are left.
  for (let n = 0; n < 5 && (await page.locator("[data-fold][aria-expanded=false]").count()); n++) await page.locator("[data-fold][aria-expanded=false]").first().click();
}

async function pageTests(browser, body, optBody, scanBody) {
  console.log("Page");
  // The saved futures have no live callout at that moment, so make Micro Gold's newest one live, fired an hour ago.
  body = JSON.parse(JSON.stringify(body));
  const T2 = require(path.join(ROOT, "api/_trendlines.js")), chartOf = (f, sym, sig, now) => T2.scan(load("yahoo_" + f + ".json"), load("yahoo_daily_" + f + ".json"), { sym, all: true, now }).signals.find((x) => x.t === sig.t && x.setup === sig.setup && x.tf === sig.tf).chart;
  const mgcSig0 = body.markets.find((m) => m.sym === "MGC=F").signals[0];
  ok(mgcSig0.status === "open" || mgcSig0.chart === null, "charts aren't sent for callouts the page can't show (smaller download)");
  // (charts are only sent for live callouts, so attach this one's chart before making it live)
  Object.assign(mgcSig0, { chart: chartOf("GC", "MGC=F", mgcSig0, NOW), status: "open", nowR: 0.1, liveThrough: false, t: NOW - 3600 });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }), errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  let scanJson = { at: Date.now(), scanned: 108, failed: ["NIO", "PDD"], markets: [] };
  await page.route("**/api/scan**", (r) => r.fulfill({ json: scanJson }));
  await page.route("**/api/news**", (r) => r.fulfill({ json: NEWS }));
  await page.route("**/api/earnings**", (r) => r.fulfill({ json: EARN }));
  await page.clock.setFixedTime(NOW * 1000); // the browser's "now" = when the saved data was taken
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent), null, { timeout: 8000 }).catch(() => {});
  const futR = body.markets.filter((m) => m.kind === "futures" && m.record && m.record.trades).reduce((a, m) => a + m.record.totalR, 0);
  const trk = (await page.locator(".trk").textContent());
  ok(await page.evaluate(() => document.getElementById("out").firstElementChild.classList.contains("trk")), "the track record box is at the top");
  ok(!trk.includes("Overall") && !trk.includes("stocks") && trk.includes("Track record: futures") && trk.includes((futR >= 0 ? "+" : "−") + Math.abs(futR).toFixed(1) + "%") && trk.includes("at 1% risk per trade"), "futures tab shows only the futures ROI: total % at 1% risk per trade", trk.slice(0, 160));
  await page.click("[data-fold=track]");
  const fr = body.markets.filter((m) => m.kind === "futures" && m.record && m.record.trades).map((m) => m.record), sum = (k) => fr.reduce((a, r) => a + r[k], 0);
  const wlTxt = await page.locator(".trk .wl").first().textContent();
  ok((await page.locator(".trk .wl", { hasText: "By setup" }).count()) === 1, "Details also shows results by setup");
  ok(wlTxt.includes("Average win +" + (sum("winSum") / sum("nWin")).toFixed(1) + "%") && wlTxt.includes("average loss −" + (sum("lossSum") / sum("nLoss")).toFixed(1) + "%") &&
    wlTxt.includes((sum("winSum") / sum("nWin") / (sum("lossSum") / sum("nLoss"))).toFixed(1) + "× bigger than losses") && wlTxt.includes("For every $1 lost, $" + (sum("winSum") / sum("lossSum")).toFixed(2)) && wlTxt.includes("Winners held"),
    "Details shows average win and loss, how much bigger wins are, $ made per $1 lost, and time held", wlTxt);
  ok((await page.locator(".trk .trr").count()) === body.markets.filter((m) => m.kind === "futures" && m.record && m.record.trades).length && (await page.locator(".trk", { hasText: "How this is worked out" }).count()) === 1, "Details lists each futures market and explains the replay");
  await page.click("[data-fold=track]");
  const callTxt = await page.locator("#out").textContent();
  ok((await page.locator("[data-fold=live]").textContent()).includes("Trades to get into now") && !/Live callouts|Waiting for a safety line|Skipped/.test(callTxt), "Callouts shows only \"Trades to get into now\": no Live callouts, Waiting or Skipped lists");
  ok((await page.locator(".cl").count()) === (await page.locator(".cl .st", { hasText: "GET IN NOW" }).count()), "every card on Callouts is a trade you can get into now");
  ok((await page.locator("[data-fold=live][aria-expanded=true]").count()) === 1 && (await page.locator(".gi.row").count()) === 0, "Live callouts starts open, with no green get-in boxes");
  await page.click("[data-fold=live]");
  ok((await page.locator("[data-fold=live][aria-expanded=false]").count()) === 1 && (await page.evaluate(() => localStorage.getItem("tl:liveOpen"))) === "false", "its button closes it, and the choice is remembered");
  await page.click("[data-fold=live]");
  await openFolds(page);
  ok((await page.locator("#kinds button").allTextContents()).join() === "Futures,Stocks", "only Futures and Stocks chips (no All)");
  ok((await page.locator(".foot").count()) === 0 && !/Callouts are made by a computer/.test(await page.textContent("body")), "no explanation text at the bottom of the page");
  ok((await page.locator("[data-fold=done]").count()) === 0 && !/Finished/.test(await page.locator("#out").textContent()), "no Finished list (closed trades only count in the track record)");
  ok((await page.locator(".cl .note", { hasText: "Size:" }).count()) === 0, "no position size until you enter an account size");
  await page.fill("#acct", "10,000"); await page.fill("#riskP", "1"); await page.click("#sizeF button");
  const mgcLive = body.markets.find((m) => m.sym === "MGC=F").signals[0], perC = mgcLive.risk * 10, nC = Math.floor(100 / perC);
  const sizeTxt = await page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first().locator(".note", { hasText: "Size:" }).textContent();
  ok(nC >= 1 ? sizeTxt.includes("Size: " + nC + " micro contract") : sizeTxt.includes("more than your 1%"), "position size: $10,000 at 1% sets how many micro contracts", sizeTxt + " (risk/contract $" + perC.toFixed(0) + ")");
  ok((await page.evaluate(() => localStorage.getItem("tl:acct"))) === "10000", "account size is saved on the phone");
  // Callout boxes start collapsed: summary only. Tap to open everything, tap again to close.
  ok((await page.locator(".cl[aria-expanded=false]").count()) === (await page.locator(".cl").count()) && (await page.locator(".cl .gr").count()) === 0 && (await page.locator(".cl .mini", { hasText: "Stop order" }).count()) >= 1,
    "callout boxes start collapsed, showing entry, stop order and result in one line");
  const cbH = await page.locator(".cl.sm").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  ok(cbH.length >= 1 && cbH.every((h) => h < 145), "collapsed callout boxes are compact (under 145px on a phone, with a news/market line)", cbH.map(Math.round).join(","));
  ok((await page.locator(".cl.sm .nm").count()) === 0 && (await page.locator(".cl.sm .tag", { hasText: /^(bounce|3-touch break|2-touch break|break & retest)$/ }).count()) === 0, "collapsed boxes leave the setup name and market line for the opened view");
  const mgcBox = page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first();
  const shut = await mgcBox.evaluate((e) => e.getBoundingClientRect().height);
  await mgcBox.locator(".sym").click();
  const opened = await mgcBox.evaluate((e) => e.getBoundingClientRect().height);
  ok((await mgcBox.getAttribute("aria-expanded")) === "true" && opened > shut * 2 && (await mgcBox.locator("svg").count()) >= 1, "tapping a box opens the full details and chart", Math.round(shut) + " → " + Math.round(opened) + "px");
  ok((await page.locator(".cl .gr", { hasText: "Stop order now (trailing)" }).count()) >= 1 && (await page.locator(".cl .note", { hasText: "just past the safety line" }).count()) >= 1, "live cards show the stop order to set, just past the safety line");
  const mgcTxt = await page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first().textContent();
  ok(mgcTxt.includes("Opens 6:00 PM"), "Monday 5:48 PM: futures card says the market is in its daily break", mgcTxt.slice(0, 300));
  ok(/⚠ Tue 8:30 AM: Core CPI m\/m \+1/.test(mgcTxt) && !/Crude Oil Inventories/.test(mgcTxt), "news warning for CPI tomorrow morning (crude report not shown on gold)");
  const hrs = await page.evaluate(() => [
    ["Sat noon", new Date("2026-11-14T17:00:00Z")], ["Wed 10 AM", new Date("2026-11-11T15:00:00Z")], ["Wed 5:30 PM", new Date("2026-11-11T22:30:00Z")],
    ["Fri 5:30 PM", new Date("2026-11-13T22:30:00Z")], ["Tue 8 AM", new Date("2026-11-10T13:00:00Z")]].map(([n, d]) => n + ": " + (closedUntil("futures", d) || "open") + " / " + (closedUntil("stocks", d) || "open")));
  ok(hrs.join("; ") === "Sat noon: Sun 6:00 PM / Mon 9:30 AM; Wed 10 AM: open / open; Wed 5:30 PM: 6:00 PM / Thu 9:30 AM; Fri 5:30 PM: Sun 6:00 PM / Mon 9:30 AM; Tue 8 AM: open / 9:30 AM",
    "market hours: futures Sun 6 PM - Fri 5 PM with a 5-6 PM break; stocks 9:30 AM - 4 PM weekdays", hrs.join("; "));
  const fut = await page.locator(".cl .st", { hasText: "GET IN NOW" }).allTextContents();
  ok(fut.length >= 1 && fut.every((x) => /GET IN NOW: (BUY|SELL) [A-Z]+ near/.test(x)), "futures cards say GET IN NOW: BUY or SELL (no calls or puts)", fut.join(","));
  ok((await page.locator(".cl").count()) >= 1, "callout cards render", await page.locator(".cl").count());
  ok((await page.locator(".cl .tag", { hasText: /^(A\+ · 4|B · 3)\/4$/ }).count()) === (await page.locator(".cl").count()), "every card shows how many checklist rules it passes (3/4 or 4/4)");
  ok((await page.locator(".cl .tag", { hasText: /^(4H|1H)$/ }).count()) === (await page.locator(".cl").count()), "every card says which chart it's on (4H or 1H)");
  ok((await page.locator(".cl", { hasText: /(Monthly|Weekly|Daily|4-hour|1-hour)<?\/?b?>? ?line|line \(from/ }).count()) >= 1, "cards name the line's timeframe");
  ok(/no data for ZZZ/.test(await page.textContent("#sub")), "header names symbols with no data");
  ok(/scanned 108 stocks/.test(await page.textContent("#sub")), "header shows how many stocks were scanned");
  ok(asked.length && asked[0].includes("s=MGC=F,MCL=F") && asked[0].includes("tf=4H"), "page asks for Micro Gold and Micro Crude on the 4-hour chart", asked[0]);
  ok((await page.locator("#tfSw").count()) === 0 && !/1-hour|Both/.test(await page.textContent("#mine")) && !/4-hour chart/.test(await page.locator(".trk").textContent()), "no chart switch: the 4-hour chart is just the standard (not shown)");
  const syms = await page.locator(".cl .sym").allTextContents();
  ok(syms.includes("MGC") && !syms.some((x) => x.includes("=F")), "futures show as MGC and MCL, without Yahoo's =F", syms.join(","));
  ok(!/=F/.test(await page.textContent("#mkList")), "your-markets list shows MGC, MCL without =F");
  ok(/Per micro contract: starting risk \$[\d,]+.*\(\$10 per 1\.00 move\)/.test(await page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first().textContent()), "Micro Gold callout shows risk per contract");
  // TradingView: a link on every card to the same market and chart, and the lines as points and a Pine Script.
  ok((await page.locator("a[href*='tradingview.com']").count()) === 0, "no TradingView links on the cards");
  const mgc = page.locator(".cl", { has: page.locator(".sym", { hasText: /^MGC$/ }) }).first();
  ok((await page.locator("[data-tvl], .tvp, textarea").count()) === 0 && !/Lines for TradingView/.test(await page.textContent("#out")), "no Lines for TradingView panel on the cards");
  // Journal: take this trade, close it with an exit price, see the result and stats, remove it.
  await mgc.locator("[data-took]").click();
  ok((await mgc.locator("[data-took]").textContent()) === "In your journal ✓", "\"I took this trade\" adds it to the journal");
  await page.click("[data-tab=journal]");
  ok((await page.locator("#out article.wc").count()) === 1 && (await page.locator("#kinds").isHidden()) && /1 open trade/.test(await page.locator("#out").textContent()), "Journal tab lists the open trade (no Futures/Stocks chips there)");
  const mgcSig = body.markets.find((m) => m.sym === "MGC=F").signals[0];
  const jEntry = mgcSig.entry, jRisk = mgcSig.risk, jExit = mgcSig.dir === "long" ? jEntry + 2 * jRisk : jEntry - 2 * jRisk;
  await page.fill("#out .jx input", String(jExit)); await page.click("#out .jx button");
  const jTxt = await page.locator("#out").textContent();
  ok(/\+2\.0%/.test(jTxt) && /1 closed trade · 100% wins · 0 open/.test(jTxt) && /Bounces: 1 · 100% wins · \+2\.0%|Breaks: 1 · 100% wins · \+2\.0%|Break & retest: 1 · 100% wins · \+2\.0%/.test(jTxt) && /per contract/.test(jTxt),
    "closing it with an exit price shows +2%, win rate, results by setup and $ per micro contract", jTxt.slice(0, 260));
  ok((await page.evaluate(() => JSON.parse(localStorage.getItem("tl:journal")).length)) === 1, "journal is saved on the phone");
  page.once("dialog", (dg) => dg.accept());
  await page.click("#out [data-jdel]");
  ok(/No trades yet/.test(await page.locator("#out").textContent()), "a journal entry can be removed");
  await page.click("[data-tab=calls]");
  await mgc.locator(".chart svg").click();
  ok((await mgc.getAttribute("aria-expanded")) === "true", "tapping the chart doesn't close the box");
  await mgc.locator(".top").click();
  ok((await mgc.getAttribute("aria-expanded")) === "false" && (await page.locator(".cl svg").count()) === 0, "tapping the top of an open box closes it");
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
  ok(!(await page.locator("#onlyGood").count()), "no stocks filter checkbox (the Respects trendlines list replaces it)");
  await page.click("[data-k=futures]");
  await page.click("[data-k=stocks]"); await page.click("[data-tab=journal]");
  ok(!(await page.locator("#mine").isVisible()), "the journal has no add-symbol/settings box at the bottom");
  await page.click("[data-tab=rules]");
  ok(!(await page.locator("#mine").isVisible()), "the rules tab has no add-symbol/settings box at the bottom");
  await page.click("[data-tab=watch]");
  const awayTxt = await page.locator(".c", { has: page.locator(".sym", { hasText: /^AMZN$/ }) }).first().locator(".wl2 span", { hasText: "away" }).first().textContent();
  const aw0 = body.markets.find((m) => m.sym === "AMZN"), wantAway = "$" + Math.abs(aw0.price - aw0.watch[0].lineNow).toFixed(2) + " away";
  let lookAsk = "";
  await page.route("**/api/trades**look=1**", (r) => { lookAsk = decodeURIComponent(r.request().url()); r.fulfill({ json: { at: Date.now(), markets: [lookBody.markets ? lookBody.markets[0] : lookBody] } }); });
  await page.fill("#lookIn", "aapl"); await page.press("#lookIn", "Enter");
  await page.waitForSelector(".wc .sym:text('AAPL') >> xpath=ancestor::article//svg", { timeout: 5000 }).catch(() => {});
  const lkCard = page.locator("article.wc", { has: page.locator("[data-lookx]") });
  ok(/s=AAPL&tf=4H&look=1/.test(lookAsk) && (await lkCard.locator(".chart svg").count()) === 1 && /Nearest: (Rising|Falling) /.test(await lkCard.textContent()) && (await lkCard.locator(".lns .lnr").count()) >= 2, "Look up: any stock shows its chart, nearest line and every line", lookAsk);
  await lkCard.locator("[data-lookx]").last().click();
  ok((await page.locator("[data-lookx]").count()) === 0 && (await page.locator("#lookIn").count()) === 1, "Look up: Close removes it, the box stays");
  await page.unroute("**/api/trades**look=1**");
  ok(/⚠ Earnings Thu, Nov 12 after close/.test(await page.locator(".c", { has: page.locator(".sym", { hasText: /^AMZN$/ }) }).first().textContent()), "stocks show an earnings warning (AMZN reports Thu after close)");
  ok(!/Earnings/.test(await page.locator(".c", { has: page.locator(".sym", { hasText: /^AAPL$/ }) }).first().textContent().catch(() => "")), "no earnings warning when none is coming");
  ok(awayTxt.trim() === wantAway, "watch list shows the distance in price only (AMZN)", awayTxt + " vs " + wantAway);
  // Lines about to become A+ get a tag and sort right after A+ lines.
  const soon = await page.evaluate(() => [soonAplus({ grade: "B", days: 18, checks: { taps: true, angle: true, history: false } }), soonAplus({ grade: "B", days: 10, checks: { taps: true, angle: true, history: false } }),
    soonAplus({ grade: "B", days: 19, checks: { taps: true, angle: false, history: false } }), soonAplus({ grade: "A+", days: 30, checks: { taps: true, angle: true, history: true } })]);
  ok(JSON.stringify(soon) === "[3,null,null,null]", "\"A+ in N days\" only for lines missing just the 3 weeks, within a week of it", JSON.stringify(soon));
  const wb = JSON.parse(JSON.stringify(body)), am = wb.markets.find((m) => m.sym === "AMZN");
  am.watch = [{ ...am.watch[0], grade: "B", passed: 3, days: 17, checks: { taps: true, spacing: true, angle: true, history: false }, dist: 0.2, key: "x1", lineTF: "Daily", lineNow: +(am.price * 1.03).toFixed(2) },
    { ...am.watch[0], grade: "B", passed: 3, days: 9, checks: { taps: true, spacing: true, angle: true, history: false }, dist: 0.1, key: "x2", lineTF: "4-hour", lineNow: +(am.price * 1.001).toFixed(2) }, { ...am.watch[0], lineNow: +(am.price * 0.99).toFixed(2) }];
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: wb }));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const amzAway = await page.locator("#out article.c", { has: page.locator(".sym", { hasText: /^AMZN$/ }) }).evaluateAll((els) => els.map((e) => Number((e.querySelector(".wl2 span:last-child").textContent.match(/\$([\d,.]+) away/) || [0, "NaN"])[1].replace(/,/g, ""))));
  ok(amzAway.length === 3 && amzAway[0] < amzAway[1] && amzAway[1] < amzAway[2] && (await page.locator("#out .tag", { hasText: "A+ in 4 days" }).count()) === 1, "watch list: closest to price first (\"A+ in 4 days\" still tagged)", amzAway.join());
  // Stocks watch list: top 5, then a button for the rest. Futures: no button.
  const many = JSON.parse(JSON.stringify(body)), amz = many.markets.find((m) => m.sym === "AMZN");
  amz.watch = Array.from({ length: 8 }, (_, k) => ({ ...amz.watch[0], key: "k" + k, dist: 0.1 * (k + 1) }));
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: many }));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const hs = await page.locator("#out article.wc").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  ok(hs.length === 5 && hs.every((h) => h < 175), "watch-list boxes are compact (under 175px tall on a phone, with a news/market line and Show chart)", hs.map(Math.round).join(","));
  ok((await page.locator("#out article.wc .wl3.warn").count()) === 0 && (await page.locator("#out article.wc .ck").count()) === 0, "A+ watch boxes show no \"Missing\" note and no long checklist");
  ok((await page.locator("#out article.c").count()) === 5 && (await page.locator("[data-wall]").textContent()) === "Show all 8", "stocks watch list shows the top 5 with a \"Show all 8\" button");
  await page.click("[data-wall]");
  ok((await page.locator("#out article.c").count()) === 8 && (await page.locator("[data-wall]").textContent()).startsWith("Show only the top 5"), "Show all opens the rest, and the button shrinks it back");
  await page.click("[data-wall]");
  ok((await page.locator("#out article.c").count()) === 5, "back to 5");
  await page.click("[data-k=futures]");
  ok((await page.locator("[data-wall]").count()) === 0, "futures watch list has no show-all button");
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const wl = page.locator(".c", { has: page.locator(".sym", { hasText: /^AMZN$/ }) }).first();
  ok((await wl.count()) === 1 && (await page.locator("[data-tvl], .tvp").count()) === 0, "watch boxes have no TradingView lines panel");
  await page.unroute("**/api/trades**");
  let wAsk = "";
  await page.route("**/api/trades**", (r) => { const u = decodeURIComponent(r.request().url()); if (!/wchart=1/.test(u)) asked.push(u); if (/wchart=1/.test(u)) { wAsk = u; r.fulfill({ json: { at: Date.now(), markets: [amzWChart] } }); } else r.fulfill({ json: body }); });
  await wl.locator("[data-wch]").click();
  await page.waitForSelector(".wc .chart svg", { timeout: 5000 }).catch(() => {});
  ok(/s=AMZN&tf=4H&wchart=1/.test(wAsk) && (await wl.locator(".chart svg").count()) === 1 && (await wl.locator(".lns .lnr").count()) >= 2, "watch box: Show chart loads that stock's chart with every line", wAsk);
  const wTaps = amzWChart.watch[0].chart.taps.length;
  ok(new RegExp("○ " + wTaps + " taps? on the thick line( \\([^)]*\\))?: ").test(await wl.textContent()), "watch chart lists every tap with its date and price", wTaps);
  const circ = await page.evaluate(() => {
    const bars = Array.from({ length: 320 }, (_, i) => [1790000000 + i * 14400, 100, 101, 99, 100]);
    const C = (taps) => ({ bars, at: 319, tapIdx: taps, line: { i0: taps[0], p0: 101, slope: -0.001, i1: taps[1] }, chains: [], lines: [] });
    const n = (taps) => (chart({ sym: "X", digits: 2, price: 100 }, { tf: "4H", chart: C(taps), status: "watch" }).match(/<circle/g) || []).length;
    return [n([60, 200, 315]), n([5, 200, 315])];
  });
  const marks = await page.evaluate(() => [tapMark(1, 2, "#000", false), tapMark(1, 2, "#000", true)]);
  ok(/fill="#000"/.test(marks[0]) && /fill="none"/.test(marks[1]) && /stroke-dasharray/.test(marks[1]) && !/stroke-dasharray/.test(marks[0]), "real touches are solid dots, near misses hollow dashed rings");
  ok(circ[0] === 3 && circ[1] === 2, "the 4-hour chart starts before the line's first tap (up to ~300 candles back), so every tap is circled", circ.join());
  await wl.locator("[data-zoom][data-mode=zoom]").click();
  ok((await wl.locator("svg circle").count()) >= Math.min(wTaps, 1), "the 2-year view circles the taps too", await wl.locator("svg circle").count());
  ok((await wl.locator("svg[aria-label^='Daily chart, 2 years']").count()) === 1, "the watch chart has the 2-year view too");
  await wl.locator("[data-wch]").click();
  ok((await wl.locator(".chart").count()) === 0 && /Show chart/.test(await wl.locator("[data-wch]").textContent()), "Hide chart closes it");
  await page.click("[data-k=futures]");
  await page.click("[data-tab=rules]");
  ok((await page.locator("text=Top-down analysis").count()) >= 1 && (await page.locator("text=previous point B is new point A").count()) >= 1, "rules tab explains her top-down steps");
  const rulesTxt = await page.locator(".rules").textContent();
  ok(["Break & retest", "Bounce", "just past", "1–2%", "Commit to one timeframe", "Journal every trade", "Practice first", "Redraw daily"].every((x) => rulesTxt.includes(x)), "rules tab covers her whole system: setups, stop past the line, sizing, one timeframe, journaling, practice, upkeep");
  ok((await page.locator(".rules .tag", { hasText: "automatic" }).count()) >= 7 && (await page.locator(".rules .tag", { hasText: /^you$/ }).count()) >= 3, "each step says whether it's automatic or yours");
  ok(!/Sources:/.test(await page.locator(".rules").textContent()) && (await page.locator(".rules li").last().textContent()).startsWith("Practice first"), "rules end with step 12 (no text under it)");
  ok((await page.locator("text=How the computer does it").count()) === 0 && (await page.locator("#out >> text=Option contracts").count()) === 0, "rules tab has no computer or options sections");
  await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  await openFolds(page);
  ok((await page.locator(".cl .sym", { hasText: /^(M?GC|MCL|CL|PL|YM)$/ }).count()) === 0 && (await page.locator(".trk", { hasText: "Track record: stocks" }).count() + await page.locator(".gi.none", { hasText: "stocks" }).count()) >= 1, "Stocks filter hides futures and shows the stocks view");
  await page.evaluate(() => localStorage.setItem("tl:tf", '"1H"')); await page.reload(); await page.waitForTimeout(500);
  ok(asked[asked.length - 1].includes("tf=4H"), "an old 1-hour choice on the phone is ignored: still the 4-hour chart");
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
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent)); await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  const sr = scanBody.record, strk = await page.locator(".trk").textContent();
  ok(!strk.includes("Overall") && !strk.includes("futures"), "stocks tab shows only the stocks ROI");
  ok(strk.includes("Track record: stocks") && strk.includes(sr.trades + " trades") && strk.includes((sr.totalR >= 0 ? "+" : "−") + Math.abs(sr.totalR).toFixed(1) + "%"), "stocks track record shows all scanned stocks added up", strk.slice(0, 160));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent)); await page.click("[data-k=stocks]");
  await page.click("[data-tab=watch]");
  ok((await page.locator(".c .sym", { hasText: "NVDA" }).count()) >= 1, "stocks from the scan appear under Stocks (on the Watch list)");
  await page.click("[data-tab=calls]");
  scanJson = { at: Date.now(), scanned: 108, failed: [], markets: [] };

  // A live stock callout gets an options button; the panel loads contracts and doesn't flip the chart.
  const b2 = JSON.parse(JSON.stringify(body)), stock = b2.markets.find((m) => m.sym === "TEST");
  const sig = stock.signals.find((x) => x.stop0 != null) || stock.signals[0];
  if (!sig.chart) sig.chart = chartOf("TEST", "TEST", sig, NOW);
  sig.status = "open"; sig.nowR = 0.1; sig.liveThrough = false; sig.t = NOW - 3600; // fired an hour ago
  if (sig.stop0 == null) Object.assign(sig, { stop0: sig.entry * 0.97, stop: sig.entry * 0.97, risk: sig.entry * 0.03, dir: "long" });
  await page.unroute("**/api/trades**");
  await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  let optAsk = "";
  await page.route("**/api/options**", (r) => { optAsk = decodeURIComponent(r.request().url()); r.fulfill({ json: optBody }); });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-k=stocks]");
  ok((await page.locator(".cl .st", { hasText: /GET IN NOW: BUY (CALL|PUT) TEST \(stock near/ }).count()) === 1, "the card itself says GET IN NOW: BUY CALL/PUT");
  const late = JSON.parse(JSON.stringify(b2)); late.markets.find((m) => m.sym === "TEST").signals[0].nowR = 1.4;
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: late }));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  ok((await page.locator(".gi.none").count()) === 1 && (await page.locator(".cl .sym", { hasText: /^TEST$/ }).count()) === 0, "a live trade already 1.4R past entry is no longer listed");
  const old2 = JSON.parse(JSON.stringify(b2)); Object.assign(old2.markets.find((m) => m.sym === "TEST").signals[0], { t: NOW - 2 * 86400 });
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: old2 }));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  ok((await page.locator(".gi.none").count()) === 1 && (await page.locator(".cl .sym", { hasText: /^TEST$/ }).count()) === 0, "a live trade from 2 days ago is no longer listed (still counted in the track record)");
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  await openFolds(page);
  ok((await page.locator("[data-opt]").count()) === 0, "option button stays tucked away while the box is collapsed");
  await page.locator(".cl", { has: page.locator(".sym", { hasText: /^TEST$/ }) }).first().locator(".sym").click();
  ok((await page.locator("[data-opt]").count()) === 1, "live stock callout has an options button once opened");
  ok((await page.locator(".cl", { hasText: "GC=F" }).locator("[data-opt]").count()) === 0, "futures callouts have no options button");
  await page.click("[data-opt]"); await page.waitForSelector(".oc", { timeout: 5000 }).catch(() => {});
  ok((await page.locator(".oc").count()) === 1 && (await page.locator(".oc .tag", { hasText: "Best pick" }).count()) === 1, "only the best contract shows, marked Best pick");
  ok(/sym=TEST/.test(optAsk) && optAsk.includes("dir=" + sig.dir) && optAsk.includes("stop=" + sig.stop0) && !/target=/.test(optAsk), "options request carries the direction and starting stop (no target: 2R)", optAsk);
  const box = await page.locator(".oc").first().textContent();
  ok(["Bid / Ask $", "Volume ", "Open interest ", "Delta ", "Theta ", "/day)", "Implied volatility ", "%"].every((x) => box.includes(x)), "each contract shows bid/ask, volume, open interest, delta, theta and implied volatility", box);
  ok((await page.locator(".oc .on").first().textContent()).includes("Dec 18, 26 $350 Call"), "contract name reads like a broker's", await page.locator(".oc .on").first().textContent());
  const c0 = optBody.contracts[0];
  ok(c0 && c0.gamma > 0, "contracts carry gamma for the price-now estimate", c0 && c0.gamma);
  const est = await page.evaluate((c) => [estNow(c, 350, 352), estNow(c, 350, 350), estNow(c, 350, 380), estNow({ ...c, type: "call", strike: 300, mid: 1, delta: 0.1, gamma: 0 }, 350, 349)], c0);
  const want = Math.round((c0.mid + c0.delta * 2 + 0.5 * c0.gamma * 4) * 100) / 100;
  ok(est[0] && Math.abs(est[0].est - want) < 0.011 && est[0].est > c0.mid, "price now: a $2 stock move moves the option by delta (plus gamma)", JSON.stringify(est[0]) + " want " + want);
  ok(est[1].est === c0.mid && est[2] === null, "no stock move: same price; stock prices 5%+ apart: no estimate");
  ok(est[3].est === 49, "the estimate never goes below what the option is worth at expiry", est[3].est);
  ok(/15 minutes delayed/.test(await page.locator(".op").textContent()) && /Estimated price now/.test(await page.locator(".op").textContent()), "the options panel explains the delay and the estimate");
  const tb = page.locator(".cl", { has: page.locator(".sym", { hasText: /^TEST$/ }) }).first();
  ok((await tb.getAttribute("aria-expanded")) === "true", "opening options keeps the box open");
  await page.click(".op .oc");
  ok((await tb.getAttribute("aria-expanded")) === "true", "tapping inside the options panel doesn't close the box");
  await page.click("[data-opt]");
  ok((await page.locator(".oc").count()) === 0, "options button hides the panel again");
  const tPx = b2.markets.find((m) => m.sym === "TEST").price, oc2 = { ...optBody.contracts[0], strike: Math.round(tPx * 0.98) };
  await page.unroute("**/api/options**"); await page.route("**/api/options**", (r) => r.fulfill({ json: { ...optBody, price: tPx * 0.995, contracts: [oc2] } }));
  await page.reload(); await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent));
  await openFolds(page);
  await page.locator(".cl", { has: page.locator(".sym", { hasText: /^TEST$/ }) }).first().locator(".sym").click();
  await page.click("[data-opt]"); await page.waitForSelector(".oc", { timeout: 5000 }).catch(() => {});
  const ebox = await page.locator(".oc").first().textContent();
  ok(/Estimated price now: ~\$[\d,.]+ \(~\$[\d,]+ per contract\) \+\$[\d,.]+ since the quote, stock \$/.test(ebox), "the contract shows an estimated price now when the stock has moved since the quote", ebox.slice(0, 200));
  await page.click("[data-opt]");
  ok(!errors.length, "page has no errors", errors.join(" | "));
  await page.close();
}

// Faster loading and the polish: futures first, placeholders, sticky tabs, one-line header, pull to refresh.
// Phone alerts: a fake Upstash database and a fake phone push service, all in memory.
async function alertTests() {
  console.log("Phone alerts");
  const crypto = require("crypto"), db = new Map(), pushed = [];
  const H = (k) => db.get(k) || (db.set(k, new Map()), db.get(k));
  const run = ([c, k, ...a]) => {
    c = c.toUpperCase();
    if (c === "GET") return db.has(k) ? db.get(k) : null;
    if (c === "SET") { if (a.includes("NX") && db.has(k)) return null; db.set(k, a[0]); return "OK"; }
    if (c === "HGETALL") return [...H(k)].flat();
    if (c === "HSET") { H(k).set(a[0], a[1]); return 1; }
    if (c === "HDEL") return H(k).delete(a[0]) ? 1 : 0;
    if (c === "SADD") { const st = db.get(k) || new Set(); db.set(k, st); if (st.has(a[0])) return 0; st.add(a[0]); return 1; }
    throw new Error("cmd " + c);
  };
  let site = {};
  const fetcher = async (u, o = {}) => {
    u = String(u);
    if (u.startsWith("https://kv.test/pipeline")) { const out = JSON.parse(o.body).map((c) => ({ result: run(c) })); return { ok: true, status: 200, json: async () => out }; }
    if (u.startsWith("https://push.test/")) { pushed.push({ u, h: o.headers, body: o.body }); return { ok: true, status: 201 }; }
    if (u.startsWith("https://tf.test/api/")) { const k = /\/api\/scan/.test(u) ? "scan" : /&s=/.test(u) ? "extra" : "trades"; return { ok: true, status: 200, json: async () => site[k] || { markets: [] } }; }
    return { ok: false, status: 404 };
  };
  const T = NOW - 3600;
  const mk = (price, sig) => ({ sym: "MGC=F", kind: "futures", price, signals: sig ? [sig] : [], watch: [{ tf: "4H", key: "w1", lineNow: 1990, kind: "rising line under lows" }] });
  const sig = { tf: "4H", setup: "break", dir: "long", t: T, status: "open", nowR: 0.2, entry: 1995, stop: 1985, stop0: 1985, risk: 10, grade: "A" };
  const invoke = async (file, method, body) => {
    const saved = global.fetch, realNow = Date.now;
    global.fetch = fetcher; Date.now = () => NOW * 1000;
    process.env.KV_REST_API_URL = "https://kv.test"; process.env.KV_REST_API_TOKEN = "t";
    try {
      return await new Promise((r) => { const res = { statusCode: 200, setHeader() {}, end(b) { r({ status: res.statusCode, body: JSON.parse(b) }); } }; require(path.join(ROOT, file))({ method, url: "/", headers: { host: "tf.test" }, body }, res); });
    } finally { global.fetch = saved; Date.now = realNow; delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; }
  };
  ok((await call("api/push.js", "/api/push", async () => ({ ok: false }))).body.configured === false, "without the database, the page is told phone alerts aren't set up");
  const info = await invoke("api/push.js", "GET");
  ok(info.body.configured && /^[A-Za-z0-9_-]{87}$/.test(info.body.publicKey), "with the database, the site makes its alert key once", info.body.publicKey);
  ok((await invoke("api/push.js", "GET")).body.publicKey === info.body.publicKey, "the alert key stays the same");
  // A phone: its own keys, so we can open the message like the phone would.
  const ua = crypto.createECDH("prime256v1"), uaPub = ua.generateKeys(), auth = crypto.randomBytes(16), b64 = (b) => b.toString("base64url");
  const sub = { endpoint: "https://push.test/phone1", keys: { p256dh: b64(uaPub), auth: b64(auth) } };
  const open = (buf) => {
    const salt = buf.subarray(0, 16), idlen = buf[20], asPub = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
    const ikm = Buffer.from(crypto.hkdfSync("sha256", ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
    const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)), nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    return JSON.parse(pt.subarray(0, pt.lastIndexOf(2)).toString());
  };
  ok((await invoke("api/push.js", "POST", { action: "subscribe", sub, prefs: { tf: "4H" } })).body.ok, "a phone can turn on alerts");
  ok((await invoke("api/push.js", "POST", { action: "alert", endpoint: "https://push.test/nobody", alert: { id: "x", sym: "MGC=F", level: 1, dir: "above" } })).status === 404, "a line alert needs alerts turned on first");
  ok((await invoke("api/push.js", "POST", { action: "alert", endpoint: sub.endpoint, alert: { id: "MGC=F|4H|w1", sym: "MGC=F", tf: "4H", key: "w1", level: 1990, dir: "below", label: "Rising 4H line" } })).body.ok, "a phone can ask for an alert at a watch-list line");
  await invoke("api/push.js", "POST", { action: "test", endpoint: sub.endpoint });
  const t0 = pushed.length && open(pushed[0].body);
  ok(t0 && t0.title === "Trade Finder" && pushed[0].h["Content-Encoding"] === "aes128gcm" && /^vapid t=.+, k=/.test(pushed[0].h.Authorization), "turning alerts on sends a test alert, encrypted for that phone", JSON.stringify(t0));
  pushed.length = 0;
  site = { trades: { markets: [mk(1996, sig)] } };
  const n1 = await invoke("api/notify.js", "GET");
  const msg = pushed.map((x) => open(x.body));
  ok(n1.body.ran && n1.body.notified === 1 && msg[0] && msg[0].title === "BUY MGC" && /entry 1995/.test(msg[0].body), "a new Get-in-now callout goes to the phone", JSON.stringify(n1.body) + " " + JSON.stringify(msg));
  ok((await invoke("api/notify.js", "GET")).body.reason === "ran recently", "the check runs at most every 9 minutes");
  db.delete("tf:lastrun"); pushed.length = 0;
  await invoke("api/notify.js", "GET");
  ok(pushed.length === 0, "the same callout is never sent twice");
  const live = (await invoke("api/push.js", "GET")).body.live;
  ok(live.length === 1 && live[0].status === "open" && live[0].sym === "MGC=F" && live[0].view === "4H", "sent callouts are saved in the live record", JSON.stringify(live));
  db.delete("tf:lastrun"); pushed.length = 0;
  site = { trades: { markets: [mk(1989, { ...sig, nowR: -0.6 })] } };
  await invoke("api/notify.js", "GET");
  const m2 = pushed.map((x) => open(x.body));
  ok(m2.length === 1 && /reached your line/.test(m2[0].title) && /1990/.test(m2[0].body), "price reaching the watched line sends an alert", JSON.stringify(m2));
  ok(!JSON.parse(H("tf:subs").get(sub.endpoint)).alerts.length, "a line alert is sent once, then removed");
  ok((await invoke("api/push.js", "GET")).body.live[0].nowR === -0.6, "the live record follows the open trade");
  db.delete("tf:lastrun"); pushed.length = 0;
  site = { trades: { markets: [mk(1999, { ...sig, nowR: 0.4, stop: 1990 })] } };
  await invoke("api/notify.js", "GET");
  const m3 = pushed.map((x) => open(x.body));
  ok(m3.length === 1 && m3[0].title === "Move stop: BUY MGC" && /New stop 1990 \(was 1985\)/.test(m3[0].body), "exit alerts: the phone is told when the stop trails to a new level", JSON.stringify(m3));
  db.delete("tf:lastrun"); pushed.length = 0;
  site = { trades: { markets: [mk(1999, { ...sig, nowR: 0.4, stop: 1990.5 })] } };
  await invoke("api/notify.js", "GET");
  ok(pushed.length === 0, "a tiny stop change (under 0.1R) doesn't send an alert");
  db.delete("tf:lastrun"); pushed.length = 0;
  site = { trades: { markets: [mk(1980, { ...sig, status: "closed", exitR: -1, exitHow: "stop order", exitPx: 1989 })] } };
  await invoke("api/notify.js", "GET");
  const m4 = pushed.map((x) => open(x.body));
  ok(m4.length === 1 && m4[0].title === "Exit BUY MGC: −1.0%" && /Stop order hit at 1989/.test(m4[0].body), "exit alerts: the phone is told when the trade closes, with the result", JSON.stringify(m4));
  const l2 = (await invoke("api/push.js", "GET")).body.live[0];
  ok(l2.status === "closed" && l2.exitR === -1, "when the trade closes, the live record keeps its result", JSON.stringify(l2));
  ok((await invoke("api/push.js", "POST", { action: "unsubscribe", endpoint: sub.endpoint })).body.ok && !H("tf:subs").has(sub.endpoint), "a phone can turn alerts off");
  return { configured: true, publicKey: info.body.publicKey, live: [{ ...l2, t: NOW - 86400 * 3 }, { ...l2, key: "b", status: "open", exitR: null, nowR: 0.3 }] };
}

async function alertPageTests(browser, body, scanBody, pushBody) {
  console.log("Phone alerts on the page");
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  ok(/addEventListener\("push"/.test(await (await fetch("http://127.0.0.1:" + PORT + "/sw.js")).text()), "the alert helper (sw.js) is served");
  await page.route("**/api/trades**", (r) => r.fulfill({ json: body }));
  await page.route("**/api/scan**", (r) => r.fulfill({ json: scanBody }));
  await page.route("**/api/news**", (r) => r.fulfill({ json: NEWS }));
  await page.route("**/api/earnings**", (r) => r.fulfill({ json: EARN }));
  await page.route("**/api/push**", (r) => r.fulfill({ json: pushBody }));
  await page.clock.setFixedTime(NOW * 1000);
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(200);
  const tr = await page.locator(".trk").first().textContent();
  ok(/Live record since .*1 closed · 0% wins · −1\.0% · 1 open/.test(tr), "the track record shows the live record of sent callouts", tr.slice(0, 300));
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  const n = await page.locator("[data-lal]").count();
  ok(n > 0 && /Alert me at this line/.test(await page.locator("[data-lal]").first().textContent()), "watch-list lines have an Alert me button", n);
  page.once("dialog", (d) => { ok(/Turn on 🔔 Alerts/.test(d.message()), "Alert me asks you to turn on alerts first", d.message()); d.dismiss(); });
  await page.locator("[data-lal]").first().click();
  await page.waitForTimeout(200);
  ok(!errors.length, "no page errors with phone alerts", errors.join(" | "));
  await page.close();
}

async function rankPageTests(browser, body, scanBody) {
  console.log("Respects trendlines list");
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const syms = scanBody.markets.map((m) => m.sym), inList = syms[0], outList = syms.find((x) => x !== inList);
  const ranks = [{ sym: inList, trades: 9, wins: 6, totalR: 8.2 }, { sym: "ZZZZ", trades: 5, wins: 3, totalR: 4.1 }].concat(Array.from({ length: 6 }, (_, i) => ({ sym: "R" + i, trades: 4, wins: 2, totalR: 3 - i * 0.3 })));
  await page.route("**/api/trades**", (r) => r.fulfill({ json: body }));
  await page.route("**/api/scan**", (r) => r.fulfill({ json: { ...scanBody, ranks } }));
  await page.route("**/api/news**", (r) => r.fulfill({ json: NEWS }));
  await page.route("**/api/earnings**", (r) => r.fulfill({ json: EARN }));
  await page.clock.setFixedTime(NOW * 1000);
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForFunction(() => /scanned/.test(document.getElementById("sub").textContent), null, { timeout: 5000 }).catch(() => {});
  await page.click("[data-k=stocks]");
  ok((await page.locator(".rkb").count()) === 0, "the ranked box isn't on Callouts");
  await page.click("[data-tab=watch]");
  const box = page.locator(".rkb");
  ok((await box.count()) === 1 && (await box.locator(".trr").count()) === 5 && /1\. /.test(await box.locator(".trr").first().textContent()) && /\+8\.2%/.test(await box.textContent()) && /risking 1% on each trade/.test(await box.textContent()), "Stocks watch list: a ranked Respects trendlines box with the top 5");
  ok(/No line nearby/.test(await box.textContent()) && /(Callout now|Near a line)/.test(await box.textContent()), "each ranked stock says where it is now");
  await box.locator("[data-fold=ranks]").click();
  ok((await page.locator(".rkb").locator(".trr").count()) === 8, "Show all opens the whole list");
  await page.click("[data-k=futures]");
  ok((await page.locator(".rkb").count()) === 0, "the ranked box is only on Stocks");
  await page.click("[data-k=stocks]");
  const shown = await page.locator(".c .sym").allTextContents();
  ok(shown.includes(inList) && shown.includes(outList), "the watch list still shows every stock with a line (no filter)", shown.join());
  ok(!errors.length, "no page errors with the ranked list", errors.join(" | "));
  await page.close();
}

async function polishTests(browser, body, scanBody) {
  console.log("Loading and layout");
  const page = await browser.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true }), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let trades = 0, release;
  const scanGate = new Promise((r) => { release = r; });
  await page.route("**/api/trades**", (r) => { trades++; r.fulfill({ json: body }); });
  await page.route("**/api/scan**", async (r) => { await scanGate; r.fulfill({ json: scanBody }); }); // a slow stock scan
  await page.route("**/api/news**", (r) => r.fulfill({ json: NEWS }));
  await page.route("**/api/earnings**", (r) => r.fulfill({ json: EARN }));
  await page.clock.setFixedTime(NOW * 1000);
  await page.goto("http://127.0.0.1:" + PORT + "/");
  ok((await page.locator("#out .sk").count()) >= 1 || (await page.locator(".trk").count()) >= 1, "grey placeholder boxes show while loading");
  await page.waitForFunction(() => /Updated/.test(document.getElementById("sub").textContent), null, { timeout: 5000 }).catch(() => {});
  ok((await page.locator(".trk").count()) === 1 && /scanning stocks…/.test(await page.textContent("#sub")), "futures show right away while the stock scan is still running");
  await page.click("[data-k=stocks]");
  ok(/Scanning about 110 stocks/.test(await page.textContent("#out")), "stocks tab says the scan is running");
  release();
  await page.waitForFunction(() => /scanned/.test(document.getElementById("sub").textContent), null, { timeout: 5000 }).catch(() => {});
  ok(/scanned \d+ stocks/.test(await page.textContent("#sub")) && !/Scanning about 110 stocks/.test(await page.textContent("#out")), "stocks fill in when the scan finishes", await page.textContent("#sub"));
  const subH = await page.locator("#sub").evaluate((e) => e.getBoundingClientRect().height);
  ok(subH < 24 && /^Updated \d/.test((await page.textContent("#sub")).trim()), "header is one short line (Updated … · scanned … stocks)", subH + "px");
  await page.click("[data-k=futures]");
  await page.evaluate(() => { document.body.style.minHeight = "3000px"; window.scrollTo(0, 1500); });
  await page.waitForTimeout(100);
  const top = await page.locator("#stick").evaluate((e) => e.getBoundingClientRect().top);
  ok(top <= 1 && (await page.locator(".tabs").isVisible()) && (await page.locator("#kinds").isVisible()), "tabs and Futures/Stocks stay at the top while scrolling", "top " + top);
  await page.evaluate(() => window.scrollTo(0, 0));
  const before = trades;
  await page.evaluate(async () => {
    const t = (y) => new Touch({ identifier: 1, target: document.body, clientX: 150, clientY: y });
    window.dispatchEvent(new TouchEvent("touchstart", { touches: [t(100)] }));
    window.dispatchEvent(new TouchEvent("touchmove", { touches: [t(260)] }));
    window.dispatchEvent(new TouchEvent("touchend", { touches: [] }));
  });
  await page.waitForTimeout(500);
  ok(trades > before, "pulling down from the top refreshes", before + " → " + trades);
  const before2 = trades;
  await page.evaluate(async () => {
    const t = (y) => new Touch({ identifier: 1, target: document.body, clientX: 150, clientY: y });
    window.dispatchEvent(new TouchEvent("touchstart", { touches: [t(100)] }));
    window.dispatchEvent(new TouchEvent("touchmove", { touches: [t(130)] }));
    window.dispatchEvent(new TouchEvent("touchend", { touches: [] }));
  });
  await page.waitForTimeout(300);
  ok(trades === before2, "a small pull doesn't refresh");
  ok(!errors.length, "no errors while loading", errors.join(" | "));
  await page.close();
}

(async () => {
  let body;
  try { body = await scannerTests(); } catch (e) { ok(false, "scanner tests crashed", e.message); }
  let scanBody;
  try { scanBody = await scanTests(); } catch (e) { ok(false, "scan tests crashed", e.message); }
  let optBody;
  try { optBody = await optionsTests(); } catch (e) { ok(false, "options tests crashed", e.message); }
  let pushBody;
  try { pushBody = await alertTests(); } catch (e) { ok(false, "alert tests crashed", e.stack); }
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch();
  try { if (body && optBody && scanBody) await pageTests(browser, body, optBody, scanBody); } catch (e) { ok(false, "page tests crashed", e.message); }
  try { if (body && scanBody) await polishTests(browser, body, scanBody); } catch (e) { ok(false, "loading/layout tests crashed", e.message); }
  try { if (body && scanBody) await rankPageTests(browser, body, scanBody); } catch (e) { ok(false, "ranked list tests crashed", e.message); }
  try { if (body && scanBody && pushBody) await alertPageTests(browser, body, scanBody, pushBody); } catch (e) { ok(false, "alert page tests crashed", e.message); }
  await browser.close(); server.kill();
  console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
