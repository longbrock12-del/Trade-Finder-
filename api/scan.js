// Trade Finder - GET /api/scan
// Scans a list of big, heavily traded US stocks and ETFs (all with active options) top-down, on 4-hour and
// 1-hour charts with the same trendline rules as futures, and returns only ones with a callout or a line near price.
// Cached 15 minutes at Vercel's edge, so Yahoo sees one scan per 15 minutes however many people look.
const { scan } = require("./_trendlines.js");
const { both, chartsFrom } = require("./trades.js");

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
const POOL = 6; // stocks at a time (2 Yahoo requests each)

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=900" : "no-store");
  res.end(JSON.stringify(obj));
}

async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, 0, { error: "GET only" });
  const found = [], failed = [], recs = [], tfs = chartsFrom(req);
  // Test-only rule settings: ?touch=0.15 (tap distance in ATR, 0.02-1) and/or ?gap=4 (shortest line in candles, 2-20).
  // Answers with just the 6-month record of all scanned stocks; live callouts and alerts never use these.
  const sp = new URL(req.url, "http://x").searchParams, num = (k, lo, hi) => { const v = sp.get(k); if (v == null || v === "") return null; const n = Number(v); return n >= lo && n <= hi ? n : NaN; };
  const touch = num("touch", 0.02, 1), gap = num("gap", 2, 20), rules = touch != null || gap != null ? { touch, gap: gap == null ? null : Math.round(gap) } : null;
  if (rules && (Number.isNaN(touch) || Number.isNaN(gap))) return send(res, 400, 0, { error: "touch must be 0.02-1 (ATR), gap 2-20 (candles)" });
  let next = 0;
  async function worker() {
    while (next < UNIVERSE.length) {
      const sym = UNIVERSE[next++];
      try {
        const m = { ...scan(...(await both(sym)), { sym, tfs, rules }), sym };
        if (m.error) { failed.push(sym); continue; }
        if (m.record) recs.push({ sym, ...m.record });
        if (m.signals.length || m.watch.length) found.push(m);
      } catch (e) { failed.push(sym); }
    }
  }
  await Promise.all(Array.from({ length: POOL }, worker));
  const scanned = UNIVERSE.length - failed.length;
  found.sort((a, b) => UNIVERSE.indexOf(a.sym) - UNIVERSE.indexOf(b.sym));
  if (rules) return send(res, scanned ? 200 : 502, scanned ? 3600 : 0, { at: Date.now(), test: { touch: rules.touch == null ? 0.3 : rules.touch, gap: rules.gap == null ? 6 : rules.gap }, scanned, record: combine(recs) });
  send(res, scanned ? 200 : 502, scanned ? 900 : 0, { at: Date.now(), scanned, failed, markets: found, record: combine(recs), ranks: ranks(recs) });
}

// Stocks that respect trendlines: the top 10 by 6-month total R on this chart (3+ trades, positive total).
const RANKS = 10;
function ranks(recs) {
  return recs.filter((r) => r.trades >= 3 && r.totalR > 0).sort((a, b) => b.totalR - a.totalR).slice(0, RANKS)
    .map((r) => ({ sym: r.sym, trades: r.trades, wins: r.wins, totalR: Math.round(r.totalR * 10) / 10 }));
}

// The track record of every scanned stock added up, plus the best and worst stocks by total R.
function combine(recs) {
  const r2 = (x) => Math.round(x * 100) / 100, used = recs.filter((r) => r.trades);
  const trades = used.reduce((a, r) => a + r.trades, 0), totalR = used.reduce((a, r) => a + r.totalR, 0);
  const by = used.map((r) => ({ sym: r.sym, trades: r.trades, totalR: r.totalR })).sort((a, b) => b.totalR - a.totalR);
  return {
    stocks: used.length, from: used.length ? Math.min(...used.map((r) => r.from)) : null, trades, wins: used.reduce((a, r) => a + r.wins, 0),
    totalR: r2(totalR), avgR: trades ? r2(totalR / trades) : null, best: by.slice(0, 5), worst: by.slice(-5).reverse(),
    ...Object.fromEntries(["nWin", "nLoss", "winSum", "lossSum", "winHrs", "lossHrs"].map((k) => [k, r2(used.reduce((a, r) => a + (r[k] || 0), 0))])),
    bySetup: used.reduce((acc, r) => { Object.entries(r.bySetup || {}).forEach(([k, v]) => { const b = (acc[k] = acc[k] || { trades: 0, wins: 0, totalR: 0 }); b.trades += v.trades; b.wins += v.wins; b.totalR = r2(b.totalR + v.totalR); }); return acc; }, {}),
  };
}

module.exports = handler;
module.exports.ranks = ranks;
module.exports.UNIVERSE = UNIVERSE;
