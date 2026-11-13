// Trade Finder - GET /api/news
// This week's big and moderate US economic news (Fed, CPI, jobs, PPI, retail sales, jobless claims...) plus the weekly crude oil inventory
// report, from the free ForexFactory calendar. Used to warn on callouts when big news is coming.
// Cached an hour at Vercel's edge.
const URL_THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

function send(res, status, secs, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", secs ? "public, s-maxage=" + secs + ", stale-while-revalidate=3600" : "no-store");
  res.end(JSON.stringify(obj));
}

// Keep US events marked High or Medium impact, and the crude oil inventory report (the calendar rates it Low,
// but it moves crude a lot, so it counts as High for crude). crude: true marks events that matter mainly for
// crude oil. level: "big" (High) or "moderate" (Medium), how much the release usually moves the market.
function pick(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && e.country === "USD" && e.date && (e.impact === "High" || e.impact === "Medium" || /crude oil inventories/i.test(e.title || "")))
    .map((e) => { const crude = /crude oil/i.test(e.title || ""); return { title: String(e.title), t: Math.round(Date.parse(e.date) / 1000), impact: e.impact, level: crude || e.impact === "High" ? "big" : "moderate", crude }; })
    .filter((e) => isFinite(e.t))
    .sort((a, b) => a.t - b.t);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, 0, { error: "GET only" });
  try {
    const r = await fetch(URL_THIS_WEEK, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeFinder/1.0)", Accept: "application/json" } });
    if (!r.ok) throw new Error("calendar " + r.status);
    send(res, 200, 3600, { at: Date.now(), events: pick(await r.json()) });
  } catch (e) {
    send(res, 200, 300, { at: Date.now(), events: [], error: "News calendar didn't load." }); // the page just shows no warnings
  }
};
module.exports.pick = pick;
