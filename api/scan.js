// Trade Finder - GET /api/scan
// Scans a list of big, heavily traded US stocks and ETFs (all with active options) on 4-hour charts with
// the same trendline rules as futures, and returns only the ones with a callout or a line near price.
// Cached 15 minutes at Vercel's edge, so Yahoo sees one scan per 15 minutes however many people look.
const { scan } = require("./_trendlines.js");
const { chart } = require("./trades.js");

const UNIVERSE = [
  // ETFs
  "SPY", "QQQ", "IWM", "DIA", "SMH", "XLF", "XLE", "XLK", "XLV", "GLD", "SLV", "TLT", "ARKK",
  // Tech and growth
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "AMD", "NFLX", "ORCL", "CRM", "ADBE", "INTC", "QCOM",
  "MU", "TXN", "AMAT", "LRCX", "ARM", "PLTR", "SNOW", "SHOP", "UBER", "ABNB", "PYPL", "COIN", "MSTR", "HOOD", "SOFI",
  "RBLX", "DKNG", "ROKU", "NET", "CRWD", "PANW", "DDOG", "MDB", "SMCI", "DELL", "IBM", "CSCO", "ANET", "MRVL",
  // Finance
  "JPM", "BAC", "WFC", "C", "GS", "MS", "SCHW", "V", "MA", "AXP", "BLK",
  // Health
  "UNH", "LLY", "JNJ", "PFE", "MRK", "ABBV", "TMO", "ISRG", "NVO",
  // Consumer
  "WMT", "COST", "HD", "LOW", "TGT", "NKE", "SBUX", "MCD", "DIS", "KO", "PEP", "PG", "CMG", "LULU",
  // Industrial, energy, autos, telecom, China
  "BA", "CAT", "DE", "GE", "LMT", "RTX", "XOM", "CVX", "OXY", "SLB", "FDX", "UPS", "F", "GM", "RIVN", "T", "VZ", "CMCSA",
  "BABA", "PDD", "NIO",
];
const POOL = 8; // Yahoo requests at a time

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=900" : "no-store");
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, 0, { error: "GET only" });
  const found = [], failed = [];
  let next = 0;
  async function worker() {
    while (next < UNIVERSE.length) {
      const sym = UNIVERSE[next++];
      try {
        const m = { ...scan(await chart(sym), { sym }), sym };
        if (m.error) failed.push(sym);
        else if (m.signals.length || m.watch.length) found.push(m);
      } catch (e) { failed.push(sym); }
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  const scanned = UNIVERSE.length - failed.length;
  found.sort((a, b) => UNIVERSE.indexOf(a.sym) - UNIVERSE.indexOf(b.sym));
  send(res, scanned ? 200 : 502, scanned ? 900 : 0, { at: Date.now(), scanned, failed, markets: found });
}

module.exports = handler;
module.exports.UNIVERSE = UNIVERSE;
