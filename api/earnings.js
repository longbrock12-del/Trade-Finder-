// Trade Finder - GET /api/earnings?s=AMD,SOUN
// Upcoming earnings dates for the scanned stocks (plus any extra symbols you add), from Nasdaq's free earnings
// calendar: the next 14 days. Earnings can gap a stock right through a trendline, and option prices drop right
// after, so the page warns on stock callouts and watch boxes. Cached 6 hours at Vercel's edge.
const { UNIVERSE } = require("./scan.js");

const DAYS = 14, SYM = /^[A-Z][A-Z.]{0,6}$/;
const WHEN = { "time-pre-market": "before open", "time-after-hours": "after close" };

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=3600" : "no-store");
  res.end(JSON.stringify(obj));
}

// One day of the calendar -> [{ sym, date, when }] for the symbols we care about.
function pick(json, date, want) {
  const rows = (json && json.data && Array.isArray(json.data.rows)) ? json.data.rows : [];
  return rows.filter((r) => r && want.has(String(r.symbol).toUpperCase())).map((r) => ({ sym: String(r.symbol).toUpperCase(), date, when: WHEN[r.time] || "" }));
}

// Weekdays from today (New York) for the next DAYS days, as YYYY-MM-DD.
function days(now = Date.now()) {
  const out = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(now + i * 86400000), ny = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
    if (ny.getDay() === 0 || ny.getDay() === 6) continue;
    out.push(ny.getFullYear() + "-" + String(ny.getMonth() + 1).padStart(2, "0") + "-" + String(ny.getDate()).padStart(2, "0"));
  }
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, 0, { error: "GET only" });
  const extra = (new URL(req.url, "http://x").searchParams.get("s") || "").toUpperCase().split(",").map((x) => x.trim()).filter((x) => SYM.test(x)).slice(0, 30);
  const want = new Set(UNIVERSE.concat(extra)), next = {};
  let ok = 0;
  await Promise.all(days().map(async (date) => {
    try {
      const r = await fetch("https://api.nasdaq.com/api/calendar/earnings?date=" + date, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "application/json, text/plain, */*", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" },
      });
      if (!r.ok) return;
      ok++;
      pick(await r.json(), date, want).forEach((e) => { if (!next[e.sym] || e.date < next[e.sym].date) next[e.sym] = { date: e.date, when: e.when }; });
    } catch (e) { /* that day is skipped */ }
  }));
  if (!ok) return send(res, 200, 600, { at: Date.now(), earnings: {}, error: "Earnings calendar didn't load." }); // the page just shows no warnings
  send(res, 200, 6 * 3600, { at: Date.now(), earnings: next });
};
module.exports.pick = pick;
module.exports.days = days;
