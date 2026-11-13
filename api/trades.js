// Trade Finder - GET /api/trades?s=MGC=F,MCL=F,AMD   (no s: the two micro futures)
// Pulls 6 months of hourly and 10 years of daily bars per symbol from Yahoo Finance and runs the top-down
// Tori Trades trendline scanner (api/_trendlines.js). Cached 5 minutes at Vercel's edge.
const { scan } = require("./_trendlines.js");

const FUTURES = ["MGC=F", "MCL=F"]; // Micro Gold and Micro Crude only. Stocks come from api/scan.js.
const MAX = 24;
const SYM = /^[A-Z0-9^][A-Z0-9.=^-]{0,14}$/;

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=600" : "no-store");
  res.end(JSON.stringify(obj));
}

async function chart(sym, interval = "60m", range = "6mo") {
  let last;
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch("https://" + host + ".finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(sym) + "?interval=" + interval + "&range=" + range + "&includePrePost=false", {
        signal: AbortSignal.timeout(9000),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeFinder/1.0)", Accept: "application/json" },
      });
      if (r.status === 404) throw new Error("unknown symbol");
      if (!r.ok) throw new Error("Yahoo " + r.status);
      return await r.json();
    } catch (e) { last = e; if (e.message === "unknown symbol") break; }
  }
  throw last;
}

// Top-down needs both: 6 months of hourly candles (4-hour and 1-hour charts) and 10 years of daily ones
// (the monthly, weekly and daily lines).
// hourRange (tests only): a longer replay, e.g. "2y" (Yahoo keeps about 730 days of hourly candles).
async function both(sym, hourRange = "6mo") {
  const hourly = hourRange === "6mo" ? chart(sym) : chart(sym, "60m", hourRange).catch(() => chart(sym, "60m", "729d"));
  return Promise.all([hourly, chart(sym, "1d", "10y")]);
}

// ?tf=4H (default), 1H or both: which chart callouts come from.
function chartsFrom(req) {
  const tf = new URL(req.url, "http://x").searchParams.get("tf");
  return tf === "1H" ? ["1H"] : tf === "both" ? ["4H", "1H"] : ["4H"];
}

async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, 0, { error: "GET only" });
  const q = new URL(req.url, "http://x").searchParams.get("s");
  const list = q ? [...new Set(q.toUpperCase().split(",").map((x) => x.trim()).filter((x) => SYM.test(x)))].slice(0, MAX) : FUTURES;
  const sp = new URL(req.url, "http://x").searchParams, one = list.length === 1;
  const tfs = chartsFrom(req), watchCharts = sp.get("wchart") === "1" && one, lookup = sp.get("look") === "1" && one; // one market: its watch-line charts / a look-up chart
  const markets = await Promise.all(list.map(async (sym) => {
    try {
      return { ...scan(...(await both(sym)), { sym, tfs, watchCharts, lookup }), sym };
    } catch (e) { return { sym, error: e.message || "failed" }; }
  }));
  const okCount = markets.filter((m) => !m.error).length;
  send(res, okCount ? 200 : 502, okCount ? 300 : 0, { at: Date.now(), markets });
}

module.exports = handler;
module.exports.DEFAULTS = { FUTURES };
module.exports.chart = chart;
module.exports.both = both;
module.exports.chartsFrom = chartsFrom;
