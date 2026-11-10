// Trade Finder - smoke test. Run before pushing:  node tests/smoke.js
// Uses saved Yahoo hourly bars in tests/fixtures (six months to Nov 9 2026: platinum, crude, gold and Dow
// futures, plus the Dow cut to stock hours as "TEST") and a saved Cboe AAPL options chain (cboe_AAPL.json,
// trimmed to 120 days and strikes within 20%), so no live prices are fetched.
// Checks the scanner follows the strategy rules, then loads the page in a headless browser.
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium). Exits 1 on failure.
const path = require("path"), fs = require("fs"), { spawn } = require("child_process");
const ROOT = path.join(__dirname, ".."), FX = path.join(__dirname, "fixtures"), PORT = 3000 + Math.floor(Math.random() * 900) + 50;
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { console.error("Playwright is not installed: npm i -g playwright && npx playwright install chromium"); process.exit(2); }

let failed = 0;
const ok = (cond, what, extra) => { console.log((cond ? "  pass  " : "  FAIL  ") + what + (extra != null && !cond ? "  (" + extra + ")" : "")); if (!cond) failed++; };
const fx = (f) => path.join(FX, f);

const YF = { "PL=F": "PL", "CL=F": "CL", "GC=F": "GC", "YM=F": "YM", TEST: "TEST", "MGC=F": "GC", "MCL=F": "CL" }; // micros trade at the full-size price
async function tradesApi(url) {
  const saved = global.fetch;
  global.fetch = async (u) => {
    const s = decodeURIComponent(String(u)).match(/chart\/([^?]+)/)[1];
    if (!YF[s]) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(fx("yahoo_" + YF[s] + ".json"))) };
  };
  const handler = require(path.join(ROOT, "api/trades.js")), realNow = Date.now;
  Date.now = () => 1794264531000; // when the saved data was taken (Nov 9 2026, 5:48 PM New York), so the forming candle stays forming
  const out = await new Promise((r) => { const res = { statusCode: 200, setHeader() {}, end(b) { r({ status: res.statusCode, body: JSON.parse(b) }); } }; handler({ method: "GET", url }, res); });
  global.fetch = saved; Date.now = realNow;
  return out;
}

async function scannerTests() {
  console.log("Scanner");
  const { hourly, fourHour, scan } = require(path.join(ROOT, "api/_trendlines.js"));
  const etH = (t) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(t * 1000)).replace(/^24/, "00");
  const fut = fourHour(hourly(JSON.parse(fs.readFileSync(fx("yahoo_GC.json")))).bars, true, 2e9);
  ok(fut.every((b) => ["18:00", "22:00", "02:00", "06:00", "10:00", "14:00"].includes(etH(b.t))), "futures 4H candles start 6 PM, 10 PM, 2 AM, 6 AM, 10 AM, 2 PM New York", etH(fut[0].t));
  const stk = fourHour(hourly(JSON.parse(fs.readFileSync(fx("yahoo_TEST.json")))).bars, false, 2e9);
  ok(stk.length > 200 && stk.every((b) => ["09:30", "13:30"].includes(etH(b.t))), "stock 4H candles start 9:30 and 1:30", stk.length + " " + etH(stk[0].t));

  const api = await tradesApi("/api/trades?s=PL=F,CL=F,GC=F,YM=F,TEST,ZZZ,bad%20sym,MGC=F");
  const M = api.body.markets;
  ok(api.status === 200 && M.length === 7, "API scans each valid symbol and drops junk ones", M.map((m) => m.sym).join(","));
  ok(M.find((m) => m.sym === "ZZZ").error === "unknown symbol", "unknown symbol comes back as an error, not a crash");
  const good = M.filter((m) => !m.error), sigs = [], watch = [];
  good.forEach((m) => { m.signals.forEach((s) => sigs.push({ m, s })); m.watch.forEach((w) => watch.push({ m, w })); });
  ok(good.length === 6 && good.every((m) => m.bars.length >= 240 && m.price > 0 && m.atr > 0), "every market has 4H candles, a price and an ATR");
  ok(sigs.length >= 10, "saved data produces callouts", sigs.length);
  ok(sigs.some((x) => x.s.setup === "3-touch break") && sigs.some((x) => x.s.setup === "bounce"), "finds both break and bounce setups");
  ok(sigs.every(({ s }) => s.angle < 45 && s.days >= 7 && s.taps >= 2), "every callout line is under 45 degrees, 1+ week old, 2+ taps");
  ok(sigs.every(({ s }) => s.grade !== "A+" || (s.taps >= 3 && s.days >= 21)), "A+ means 3+ taps and 3+ weeks");
  ok(sigs.every(({ s }) => s.tapIdx.every((t, i) => !i || t - s.tapIdx[i - 1] >= 6)), "taps are 6+ candles apart");
  const priced = sigs.filter(({ s }) => s.stop != null);
  ok(priced.length >= 5 && priced.every(({ s }) => (s.dir === "long" ? s.stop < s.entry : s.stop > s.entry)), "stops sit on the losing side of entry");
  ok(priced.filter(({ s }) => s.target != null).every(({ s }) => s.rr >= 2 && (s.dir === "long" ? s.target > s.entry : s.target < s.entry)), "targets pay at least 2R");
  ok(sigs.filter(({ s }) => s.setup !== "bounce" && s.stop != null).every(({ s }) => s.safety && s.safety.slope * (s.dir === "long" ? 1 : -1) > 0), "break stops sit on an opposing safety line");
  ok(sigs.every(({ s }) => ["open", "target", "stopped", "too-far", "no-safety"].includes(s.status)), "every callout has a known status");
  ok(watch.every(({ w }) => w.dist <= 1.5 && w.lineNow > 0), "watch list only holds lines near price");
  const keys = sigs.map(({ m, s }) => m.sym + s.setup.slice(0, 1) + s.dir + s.at);
  ok(new Set(keys).size === keys.length, "one callout per candle per direction (copies merged)");
  ok(sigs.filter(({ s }) => s.mixed).every(({ m, s }) => m.signals.some((y) => y.at === s.at && y.dir !== s.dir)), "mixed-signal flag only where callouts disagree on a candle");
  const gc = good.find((m) => m.sym === "GC=F").signals.find((s) => s.setup === "3-touch break" && s.status === "open");
  ok(gc && gc.dir === "long" && gc.entry === 4037.3 && gc.stop === 3928.9 && gc.target === 4259, "gold 3-touch long break: entry, safety-line stop and 2R target", gc && [gc.entry, gc.stop, gc.target].join("/"));
  const def = await tradesApi("/api/trades");
  ok(def.body.markets.map((m) => m.sym).join() === "MGC=F,MCL=F" && def.body.markets.every((m) => m.kind === "futures"), "default futures are Micro Gold and Micro Crude only", def.body.markets.map((m) => m.sym).join());
  ok(def.body.markets[0].pointValue === 10 && def.body.markets[1].pointValue === 100, "micro contract values: gold $10, crude $100 per 1.00");
  ok(M.find((m) => m.sym === "MGC=F").signals.length === M.find((m) => m.sym === "GC=F").signals.length, "Micro Gold callouts match gold's chart");
  const cl = JSON.parse(fs.readFileSync(fx("yahoo_CL.json")));
  ok(JSON.stringify(scan(cl, { now: 2e9 }).signals) === JSON.stringify(scan(cl, { now: 2e9 }).signals), "same data gives the same callouts");
  return api.body;
}

async function scanTests() {
  console.log("Stock scan");
  const handler = require(path.join(ROOT, "api/scan.js")), U = handler.UNIVERSE, saved = global.fetch, realNow = Date.now;
  const run = () => new Promise((r) => { const res = { statusCode: 200, setHeader() {}, end(b) { r({ status: res.statusCode, body: JSON.parse(b) }); } }; handler({ method: "GET", url: "/api/scan" }, res); });
  const test = fs.readFileSync(fx("yahoo_TEST.json"), "utf8");
  let calls = 0;
  // Every stock gets the same saved chart except a few that fail, like a delisted ticker would.
  global.fetch = async (u) => { calls++; const s = decodeURIComponent(String(u)).match(/chart\/([^?]+)/)[1];
    return ["NIO", "PDD"].includes(s) ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => JSON.parse(test) }; };
  Date.now = () => 1794264531000;
  const t0 = realNow(); const r = await run(); const ms = realNow() - t0;
  global.fetch = saved; Date.now = realNow;
  const B = r.body;
  ok(U.length >= 100 && new Set(U).size === U.length, "scan list has 100+ different stocks and ETFs", U.length);
  ok(r.status === 200 && B.scanned === U.length - 2 && B.failed.sort().join() === "NIO,PDD", "scan counts what it scanned and names what failed", B.scanned + " " + B.failed);
  ok(B.markets.length === U.length - 2 && B.markets.every((m) => m.kind === "stocks" && U.includes(m.sym) && m.signals.length + m.watch.length > 0), "scan returns only stocks with a setup, under their own symbols");
  ok(B.markets.every((m) => m.signals.every((s) => s.at >= m.lastIdx - 10)), "stock callouts are from the last ~5 trading days");
  ok(ms < 20000, "full scan runs in under 20 seconds of work", ms + "ms");
  return B;
}

const OPT_NOW = Date.UTC(2026, 10, 10, 1); // when the saved AAPL chain was taken
async function optionsTests() {
  console.log("Option contracts");
  const { pick } = require(path.join(ROOT, "api/_options.js"));
  const chain = JSON.parse(fs.readFileSync(fx("cboe_AAPL.json")));
  const L = pick(chain, { dir: "long", entry: 350, stop: 340, target: 375 }, OPT_NOW), S = pick(chain, { dir: "short", entry: 350, stop: 358, target: null }, OPT_NOW);
  ok(L.contracts.length === 3 && S.contracts.length === 3, "three contracts for a long and for a short", L.contracts.length + "/" + S.contracts.length);
  ok(L.contracts.every((c) => c.type === "call" && c.delta > 0) && S.contracts.every((c) => c.type === "put" && c.delta < 0), "calls for longs, puts for shorts");
  const all = L.contracts.concat(S.contracts);
  ok(all.every((c) => c.dte >= 21 && c.dte <= 75), "21-75 days to expiry");
  ok(all.every((c) => Math.abs(c.delta) >= 0.45 && Math.abs(c.delta) <= 0.75), "delta 0.45-0.75");
  ok(all.every((c) => c.oi >= 100 && c.spreadPct <= 10 && c.bid > 0 && c.ask > c.bid), "open interest 100+, spread under 10%");
  ok(all.every((c) => c.atTargetPct > 0 && c.atStopPct < 0 && c.cost === Math.round(c.mid * 100)), "gains at target, loses at stop, cost is 100 shares");
  ok([L, S].every((r) => { const n = {}; r.contracts.forEach((c) => { n[c.expiry] = (n[c.expiry] || 0) + 1; }); return Object.values(n).every((x) => x <= 2); }), "no more than 2 picks from one expiry");
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
  ok(a.status === 200 && a.body.contracts.length === 3, "options API returns contracts");
  ok(f.status === 400 && /futures/.test(f.body.error), "options API turns away futures");
  ok(z.status === 404 && /No listed options/.test(z.body.error), "options API explains a stock with no options");
  return a.body;
}

// Opens every collapsed list (Finished, Skipped) on the Callouts tab.
async function openFolds(page) {
  for (const b of await page.locator("[data-fold][aria-expanded=false]").all()) await b.click();
}

async function pageTests(browser, body, optBody, scanBody) {
  console.log("Page");
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }), errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  let scanJson = { at: Date.now(), scanned: 108, failed: ["NIO", "PDD"], markets: [] };
  await page.route("**/api/scan", (r) => r.fulfill({ json: scanJson }));
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForSelector(".cl", { timeout: 8000 }).catch(() => {});
  ok((await page.locator("h2", { hasText: "Live callouts" }).count()) === 1, "page shows a Live callouts section");
  ok((await page.locator(".cl").count()) >= 3, "callout cards render", await page.locator(".cl").count());
  ok(/no data for ZZZ/.test(await page.textContent("#sub")), "header names symbols with no data");
  ok(/scanned 108 stocks/.test(await page.textContent("#sub")), "header shows how many stocks were scanned");
  ok(asked.length && asked[0].includes("s=MGC=F,MCL=F"), "page asks for Micro Gold and Micro Crude", asked[0]);
  ok(/Per micro contract: risk \$[\d,]+ · reward \$[\d,]+ \(\$10 per 1\.00 move\)/.test(await page.locator(".cl", { hasText: "MGC=F" }).first().textContent()), "Micro Gold callout shows risk and reward per contract");
  await page.locator(".cl").first().click();
  ok((await page.locator(".cl svg line").count()) > 50, "tapping a callout opens its 4H chart");
  await page.click("[data-tab=watch]");
  ok((await page.locator("text=ATR away").count()) >= 1, "watch list shows lines near price");
  await page.click("[data-tab=rules]");
  ok((await page.locator("text=safety line").count()) >= 1, "rules tab explains the checklist");
  await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  await openFolds(page);
  ok((await page.locator(".cl .sym", { hasText: "TEST" }).count()) >= 1 && (await page.locator(".cl .sym", { hasText: "GC=F" }).count()) === 0, "Stocks filter hides futures; collapsed lists open");
  await page.fill("#addIn", "amd"); await page.press("#addIn", "Enter"); await page.waitForTimeout(300);
  ok(asked.some((u) => u.includes("AMD")), "adding a symbol rescans with it");
  await page.setViewportSize({ width: 360, height: 800 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll on a small phone");
  const man = await page.evaluate(async () => { const r = await fetch("/manifest.json"); const j = await r.json(); const ic = await Promise.all(j.icons.map((i) => fetch(i.src).then((x) => x.ok))); return { name: j.name, display: j.display, icons: ic.every(Boolean) }; });
  ok(man.name === "Trade Finder" && man.display === "standalone" && man.icons, "home-screen app: named Trade Finder, opens without the address bar, icons load", JSON.stringify(man));
  ok((await page.getAttribute("meta[name=apple-mobile-web-app-title]", "content")) === "Trade Finder", "iPhone home-screen label is Trade Finder");
  // Stocks found by the scan show up next to your own symbols.
  scanJson = { ...scanBody, markets: scanBody.markets.filter((m) => m.sym === "NVDA") };
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent)); await page.click("[data-k=stocks]");
  await openFolds(page);
  ok((await page.locator(".cl .sym", { hasText: "NVDA" }).count()) >= 1, "stocks from the scan appear under Stocks");
  scanJson = { at: Date.now(), scanned: 108, failed: [], markets: [] };

  // A live stock callout gets an options button; the panel loads contracts and doesn't flip the chart.
  const b2 = JSON.parse(JSON.stringify(body)), stock = b2.markets.find((m) => m.sym === "TEST");
  const sig = stock.signals.find((x) => x.stop != null); sig.status = "open";
  await page.unroute("**/api/trades**");
  await page.route("**/api/trades**", (r) => r.fulfill({ json: b2 }));
  let optAsk = "";
  await page.route("**/api/options**", (r) => { optAsk = decodeURIComponent(r.request().url()); r.fulfill({ json: optBody }); });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.reload(); await page.waitForFunction(() => /updated/.test(document.getElementById("sub").textContent));
  await page.click("[data-k=stocks]");
  ok((await page.locator("[data-opt]").count()) === 1, "live stock callout has an options button");
  ok((await page.locator(".cl", { hasText: "GC=F" }).locator("[data-opt]").count()) === 0, "futures callouts have no options button");
  await page.click("[data-opt]"); await page.waitForSelector(".oc", { timeout: 5000 }).catch(() => {});
  ok((await page.locator(".oc").count()) === 3 && (await page.locator(".oc .tag", { hasText: "Best pick" }).count()) === 1, "three contracts show, one marked Best pick");
  ok(/sym=TEST/.test(optAsk) && optAsk.includes("dir=" + sig.dir) && optAsk.includes("stop=" + sig.stop), "options request carries the callout's direction and stop", optAsk);
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
