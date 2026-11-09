// Trade Finder - smoke test. Run before pushing:  node tests/smoke.js
// Uses saved Yahoo hourly bars in tests/fixtures (six months to Nov 9 2026: platinum, crude, gold and Dow
// futures, plus the Dow cut to stock hours as "TEST"), so no live prices are fetched.
// Checks the scanner follows the strategy rules, then loads the page in a headless browser.
// Needs Playwright with Chromium (npm i -g playwright && npx playwright install chromium). Exits 1 on failure.
const path = require("path"), fs = require("fs"), { spawn } = require("child_process");
const ROOT = path.join(__dirname, ".."), FX = path.join(__dirname, "fixtures"), PORT = 3000 + Math.floor(Math.random() * 900) + 50;
let chromium;
try { ({ chromium } = require("playwright")); } catch (e) { console.error("Playwright is not installed: npm i -g playwright && npx playwright install chromium"); process.exit(2); }

let failed = 0;
const ok = (cond, what, extra) => { console.log((cond ? "  pass  " : "  FAIL  ") + what + (extra != null && !cond ? "  (" + extra + ")" : "")); if (!cond) failed++; };
const fx = (f) => path.join(FX, f);

const YF = { "PL=F": "PL", "CL=F": "CL", "GC=F": "GC", "YM=F": "YM", TEST: "TEST" };
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

  const api = await tradesApi("/api/trades?s=PL=F,CL=F,GC=F,YM=F,TEST,ZZZ,bad%20sym");
  const M = api.body.markets;
  ok(api.status === 200 && M.length === 6, "API scans each valid symbol and drops junk ones", M.map((m) => m.sym).join(","));
  ok(M.find((m) => m.sym === "ZZZ").error === "unknown symbol", "unknown symbol comes back as an error, not a crash");
  const good = M.filter((m) => !m.error), sigs = [], watch = [];
  good.forEach((m) => { m.signals.forEach((s) => sigs.push({ m, s })); m.watch.forEach((w) => watch.push({ m, w })); });
  ok(good.length === 5 && good.every((m) => m.bars.length >= 240 && m.price > 0 && m.atr > 0), "every market has 4H candles, a price and an ATR");
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
  const cl = JSON.parse(fs.readFileSync(fx("yahoo_CL.json")));
  ok(JSON.stringify(scan(cl, { now: 2e9 }).signals) === JSON.stringify(scan(cl, { now: 2e9 }).signals), "same data gives the same callouts");
  return api.body;
}

async function pageTests(browser, body) {
  console.log("Page");
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } }), errors = [], asked = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/trades**", (r) => { asked.push(decodeURIComponent(r.request().url())); r.fulfill({ json: body }); });
  await page.goto("http://127.0.0.1:" + PORT + "/");
  await page.waitForSelector(".cl", { timeout: 8000 }).catch(() => {});
  ok((await page.locator("h2", { hasText: "Live callouts" }).count()) === 1, "page shows a Live callouts section");
  ok((await page.locator(".cl").count()) >= 3, "callout cards render", await page.locator(".cl").count());
  ok(/no data for ZZZ/.test(await page.textContent("#sub")), "header names symbols with no data");
  await page.locator(".cl").first().click();
  ok((await page.locator(".cl svg line").count()) > 50, "tapping a callout opens its 4H chart");
  await page.click("[data-tab=watch]");
  ok((await page.locator("text=ATR away").count()) >= 1, "watch list shows lines near price");
  await page.click("[data-tab=rules]");
  ok((await page.locator("text=safety line").count()) >= 1, "rules tab explains the checklist");
  await page.click("[data-tab=calls]"); await page.click("[data-k=stocks]");
  await page.click("[data-fold=done]");
  ok((await page.locator(".cl .sym", { hasText: "TEST" }).count()) >= 1 && (await page.locator(".cl .sym", { hasText: "GC=F" }).count()) === 0, "Stocks filter hides futures; finished list opens");
  await page.fill("#addIn", "amd"); await page.press("#addIn", "Enter"); await page.waitForTimeout(300);
  ok(asked.some((u) => u.includes("AMD")), "adding a symbol rescans with it");
  await page.setViewportSize({ width: 360, height: 800 });
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll on a small phone");
  ok(!errors.length, "page has no errors", errors.join(" | "));
  await page.close();
}

(async () => {
  let body;
  try { body = await scannerTests(); } catch (e) { ok(false, "scanner tests crashed", e.message); }
  const server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await chromium.launch();
  try { if (body) await pageTests(browser, body); } catch (e) { ok(false, "page tests crashed", e.message); }
  await browser.close(); server.kill();
  console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
})();
