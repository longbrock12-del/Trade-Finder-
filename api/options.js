// Trade Finder - GET /api/options?sym=AAPL&dir=long&entry=350&stop=340&target=375
// Suggests option contracts for a stock callout (see api/_options.js for how they're picked).
// Prices: Cboe delayed quotes (15 minutes late), cached 5 minutes at Vercel's edge.
const { pick, fromNasdaq } = require("./_options.js");

const SYM = /^[A-Z][A-Z.]{0,6}$/;

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=600" : "no-store");
  res.end(JSON.stringify(obj));
}

// Nasdaq's option chain for 20-76 days out, near the money: the backup when Cboe's feed doesn't answer.
async function nasdaqChain(sym) {
  const day = (k) => new Date(Date.now() + k * 86400000).toISOString().slice(0, 10);
  try {
    const r = await fetch("https://api.nasdaq.com/api/quote/" + encodeURIComponent(sym) + "/option-chain?assetclass=" + (ETFS.has(sym) ? "etf" : "stocks") + "&limit=500&fromdate=" + day(20) + "&todate=" + day(76) + "&excode=oprac&callput=callput&money=at&type=all", {
      signal: AbortSignal.timeout(9000), headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9", Origin: "https://www.nasdaq.com", Referer: "https://www.nasdaq.com/" },
    });
    if (!r.ok) return null;
    return fromNasdaq(await r.json(), sym);
  } catch (e) { return null; }
}
const ETFS = new Set(["SPY", "QQQ", "IWM", "DIA", "SMH", "XLF", "XLE", "XLK", "XLV", "GLD", "SLV", "TLT", "ARKK"]);

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, 0, { error: "GET only" });
  const p = new URL(req.url, "http://x").searchParams;
  const sym = String(p.get("sym") || "").toUpperCase(), dir = p.get("dir");
  const num = (k) => (p.get(k) == null || p.get(k) === "" ? null : Number(p.get(k)));
  const entry = num("entry"), stop = num("stop"), target = num("target");
  if (!SYM.test(sym)) return send(res, 400, 0, { error: "Options are only for stocks and ETFs, not futures." });
  if (!["long", "short"].includes(dir) || !(entry > 0) || !(stop > 0) || (target != null && !(target > 0))) return send(res, 400, 0, { error: "bad trade numbers" });
  try {
    const r = await fetch("https://cdn.cboe.com/api/global/delayed_quotes/options/" + encodeURIComponent(sym) + ".json", {
      signal: AbortSignal.timeout(9000), headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeFinder/1.0)", Accept: "application/json" },
    }).catch(() => ({ ok: false, status: 0 })); // Cboe down or blocked: Nasdaq below
    // Cboe first; if it fails or has nothing, Nasdaq's chain (same picking rules).
    let chain = null;
    if (r.ok) { try { chain = await r.json(); } catch (e) { chain = null; } }
    if (!chain || !chain.data || !Array.isArray(chain.data.options) || !chain.data.options.length) chain = await nasdaqChain(sym);
    const none = r.status === 403 || r.status === 404; // Cboe has no chain for it (and Nasdaq neither)
    if (!chain) return send(res, none ? 404 : 502, none ? 300 : 0, { error: none ? "No listed options found for " + sym + "." : "Option prices didn't load (Cboe " + r.status + ", Nasdaq too)." });
    const out = pick(chain, { dir, entry, stop, target });
    if (out.error) return send(res, 502, 0, out);
    send(res, 200, 300, { at: Date.now(), ...out });
  } catch (e) {
    send(res, 502, 0, { error: "Option prices didn't load (" + (e.message || "failed") + ")." });
  }
};
