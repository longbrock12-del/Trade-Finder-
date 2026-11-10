// Trade Finder - smoke test. Run before pushing:  node tests/smoke.js
// Uses saved Yahoo data in tests/fixtures, so no live prices are fetched:
//   yahoo_<X>.json        6 months of hourly bars to Nov 9 2026 (gold, crude, Dow, platinum futures; AAPL;
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
const NOW = 1794264531; // when the saved data was taken (Nov 9 2026, 5:48 PM New York), so the forming candle stays forming

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
  const fit = (sym) => full[sym].signals.filter((x) => x.passed >= 3);
  ok(good.every((m) => m.signals.every((x) => x.passed >= 3)), "only callouts passing at least 3 of the 4 checklist rules are listed");
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
  ok(closed.length >= 3 && closed.every(({ s }) => (s.dir === "long" ? s.exitPx < s.stop : s.exitPx > s.stop) && s.exitR != null), "closed trades ended on a candle closing through the safety line");
  ok(sigs.every(({ s }) => ["open", "closed", "too-far", "no-safety"].includes(s.status) && s.target === undefined), "every callout has a known status and no fixed target");
  const aw = scan(load("yahoo_AAPL.json"), load("yahoo_daily_AAPL.json"), { sym: "AAPL", now: NOW }).watch;
  ok(aw.length >= 1 && watch.concat(aw.map((w) => ({ w }))).every(({ w }) => w.dist <= 1.5 && w.lineNow > 0 && ["4H", "1H"].includes(w.tf)), "watch list holds the newest lines near price (AAPL has one)");
  ok(sigs.filter(({ s }) => s.mixed).every(({ m, s }) => m.signals.some((y) => y.t === s.t && y.dir !== s.dir)), "mixed-signal flag only where callouts disagree on a candle");
  const gc = full["GC=F"].signals.find((s) => s.tf === "4H" && s.setup === "3-touch break" && s.dir === "long" && s.grade === "A+");
  ok(gc && gc.lineTF === "Daily" && gc.entry === 4057 && gc.status === "too-far", "gold: 4H close above a falling Daily line on Nov 4 (A+), skipped as too far from the safety line", gc && [gc.lineTF, gc.entry, gc.status].join("/"));
  const cl = full["CL=F"].signals.find((s) => s.tf === "1H" && s.dir === "short" && s.lineTF === "Weekly");
  ok(cl && cl.entry === 85.94 && cl.stop0 === 90.08 && cl.stop === 89.76 && cl.status === "open", "crude: 1H close below a rising Weekly line, stop trailed from 90.08 to 89.76", cl && [cl.entry, cl.stop0, cl.stop, cl.status].join("/"));
  ok(sigs.every(({ s }) => s.chart.line.t0 < s.chart.line.t1 && (!s.chart.safety || s.chart.safety.t0 < s.chart.safety.t1)), "every line carries its point A and point B times (for TradingView)");
  const def = await tradesApi("/api/trades");
  ok(def.body.markets.map((m) => m.sym).join() === "MGC=F,MCL=F" && def.body.markets.every((m) => m.kind === "futures"), "default futures are Micro Gold and Micro Crude only", def.body.markets.map((m) => m.sym).join());
  ok(def.body.markets[0].pointValue === 10 && def.body.markets[1].pointValue === 100, "micro contract values: gold $10, crude $100 per 1.00");
  ok(JSON.stringify(M.find((m) => m.sym === "MGC=F").signals.map((x) => x.t)) === JSON.stringify(M.find((m) => m.sym === "GC=F").signals.map((x) => x.t)), "Micro Gold callouts match gold's chart");
  const t0 = Date.now(), a1 = scan(load("yahoo_GC.json"), load("yahoo_daily_GC.json"), { now: NOW }), ms = Date.now() - t0;
  ok(JSON.stringify(a1.signals) === JSON.stringify(scan(load("yahoo_GC.json"), load("yahoo_daily_GC.json"), { now: NOW }).signals), "same data gives the same callouts");
  ok(ms < 3000, "one futures market scans in under 3 seconds", ms + "ms");
  // The page test also gets AAPL, a real stock with a line near price.
  const aapl = await tradesApi("/api/trades?s=AAPL");
  return { ...api.body, markets: api.body.markets.concat(aapl.body.markets) };
}

async function scanTests() {
  console.log("Stock scan");
  const U = require(path.join(ROOT, "api/scan.js")).UNIVERSE;
  // Every stock gets AAPL's saved charts except two that fail, like a delisted ticker would.
  const t0 = Date.now(), r = await call("api/scan.js", "/api/scan", fakeYahoo((s) => (["NIO", "PDD"].includes(s) ? null : "AAPL"))), ms = Date.now() - t0;
  const B = r.body;
  ok(U.length >= 100 && new Set(U).size === U.length, "scan list has 100+ different stocks and ETFs", U.length);
  ok(r.status === 200 && B.scanned === U.length - 2 && B.failed.sort().join() === "NIO,PDD", "scan counts what it scanned and names what failed", B.scanned + " " + B.failed);
  ok(B.markets.length === U.length - 2 && B.markets.every((m) => m.kind === "stocks" && U.includes(m.sym) && m.signals.length + m.watch.length > 0 && m.signals.length <= 1), "scan returns only stocks with a setup, one callout each, under their own symbols");
  ok(ms < 30000, "full scan runs in under 30 seconds of work", ms + "ms");
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

// Opens every collapsed list (Finished, Skipped) on the Callouts tab.
async function openFolds(page) {
  // Each click redraws the list, so click the first closed one until none are left.
  for (let n = 0; n < 5 && (await page.locator("[data-fold][aria-expanded=false]").count()); n++) await page.locator("[data-fold][aria-expanded=false]").first().click();
}

async function pageTests(browser, body, optBody, scanBody) {
  console.log("Page");
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }), errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  let scanJson = { at: Date.now(), scanned: 108, failed: ["NIO", "PDD"], markets: [] };
  await page.route("**/api/scan", (r) => r.fulfill({ json: scanJson }));
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent), null, { timeout: 8000 }).catch(() => {});
  await openFolds(page);
  ok((await page.locator("#kinds button").allTextContents()).join() === "Futures,Stocks", "only Futures and Stocks chips (no All)");
  ok((await page.locator(".gi h3").textContent()).includes("futures"), "Callouts starts with a futures get-in box", await page.locator(".gi h3").textContent());
  const fut = (await page.locator(".gi .big").allTextContents()).map((x) => x.trim());
  ok(fut.length >= 1 && fut.every((x) => /^(BUY|SELL) [A-Z]+$/.test(x)), "futures get-ins say BUY or SELL (no calls or puts)", fut.join(","));
  ok((await page.locator(".cl").count()) >= 4, "callout cards render", await page.locator(".cl").count());
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
  ok((await page.locator(".cl svg line[stroke='#1fa463']").count()) + (await page.locator(".cl svg line[stroke='#d64545']").count()) >= 2, "the chart draws her green rising and red falling lines");
  await page.click("[data-tab=watch]"); await page.click("[data-k=stocks]");
  ok((await page.locator("text=ATR away").count()) >= 1, "watch list shows lines near price (AAPL, under Stocks)");
  const wl = page.locator(".c", { has: page.locator(".sym", { hasText: /^AAPL$/ }) }).first();
  await wl.locator("[data-tvl]").click();
  ok((await page.locator(".tvp textarea").inputValue()).includes("line.new("), "watch list lines can be copied for TradingView");
  await page.click("[data-k=futures]");
  await page.click("[data-tab=rules]");
  ok((await page.locator("text=Top-down analysis").count()) >= 1 && (await page.locator("text=previous point B is new point A").count()) >= 1, "rules tab explains her top-down steps");
  ok((await page.locator("text=How the computer does it").count()) === 0 && (await page.locator("#out >> text=Option contracts").count()) === 0, "rules tab has no computer or options sections");
  await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  await openFolds(page);
  ok((await page.locator(".cl .sym", { hasText: "TEST" }).count()) >= 1 && (await page.locator(".cl .sym", { hasText: /^M?GC$/ }).count()) === 0, "Stocks filter hides futures; collapsed lists open");
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
  scanJson = { ...scanBody, markets: scanBody.markets.filter((m) => m.sym === "NVDA") };
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent)); await page.click("[data-k=stocks]");
  await page.click("[data-tab=watch]");
  ok((await page.locator(".c .sym", { hasText: "NVDA" }).count()) >= 1, "stocks from the scan appear under Stocks (on the Watch list)");
  await page.click("[data-tab=calls]");
  scanJson = { at: Date.now(), scanned: 108, failed: [], markets: [] };

  // A live stock callout gets an options button; the panel loads contracts and doesn't flip the chart.
  const b2 = JSON.parse(JSON.stringify(body)), stock = b2.markets.find((m) => m.sym === "TEST");
  const sig = stock.signals.find((x) => x.stop0 != null) || stock.signals[0]; sig.status = "open"; sig.nowR = 0.1; sig.liveThrough = false;
  if (sig.stop0 == null) Object.assign(sig, { stop0: sig.entry * 0.97, stop: sig.entry * 0.97, risk: sig.entry * 0.03, dir: "long" });
  await page.unroute("**/api/trades**");
  await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  let optAsk = "";
  await page.route("**/api/options**", (r) => { optAsk = decodeURIComponent(r.request().url()); r.fulfill({ json: optBody }); });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-k=stocks]");
  ok((await page.locator(".gi .row").count()) === 1 && /^BUY (CALL|PUT) TEST$/.test((await page.locator(".gi .big").textContent()).trim()), "stocks get-in box says BUY CALL or BUY PUT", await page.locator(".gi").textContent());
  ok((await page.locator(".cl .st", { hasText: /GET IN NOW: BUY (CALL|PUT) TEST \(stock near/ }).count()) === 1, "the card itself says GET IN NOW: BUY CALL/PUT");
  await page.locator(".gi .row").click(); await page.waitForTimeout(200);
  ok((await page.locator(".cl svg").count()) === 1, "tapping the get-in row opens that trade's chart");
  await page.locator(".cl .sym").first().click(); // close the chart again
  const late = JSON.parse(JSON.stringify(b2)); late.markets.find((m) => m.sym === "TEST").signals[0].nowR = 1.4;
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: late }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  ok((await page.locator(".gi.none").count()) === 1 && (await page.locator(".cl .st", { hasText: "Late to get in" }).count()) === 1, "a trade already 1.4R past entry isn't a get-in: marked late");
  await page.unroute("**/api/trades**"); await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
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
