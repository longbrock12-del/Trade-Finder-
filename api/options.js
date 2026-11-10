// Trade Finder - GET /api/options?sym=AAPL&dir=long&entry=350&stop=340&target=375
// Suggests option contracts for a stock callout (see api/_options.js for how they're picked).
// Prices: Cboe delayed quotes (15 minutes late), cached 5 minutes at Vercel's edge.
const { pick } = require("./_options.js");

const SYM = /^[A-Z][A-Z.]{0,6}$/;

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=600" : "no-store");
  res.end(JSON.stringify(obj));
}

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
    });
    if (r.status === 403 || r.status === 404) return send(res, 404, 300, { error: "No listed options found for " + sym + "." });
    if (!r.ok) throw new Error("Cboe " + r.status);
    const out = pick(await r.json(), { dir, entry, stop, target });
    if (out.error) return send(res, 502, 0, out);
    send(res, 200, 300, { at: Date.now(), ...out });
  } catch (e) {
    send(res, 502, 0, { error: "Option prices didn't load (" + (e.message || "failed") + ")." });
  }
};
