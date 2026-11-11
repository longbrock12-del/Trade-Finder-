// Trade Finder - phone alerts: GET /api/push, POST /api/push {action, ...}
// GET: whether the database is connected, the site's public alert key, and the live track record.
// POST actions: subscribe {sub, prefs:{tf}}, unsubscribe {endpoint}, alert {endpoint, alert}, unalert {endpoint, id},
// test {endpoint}. Data lives in the Upstash database (see api/_store.js); nothing else to set up.
const S = require("./_store.js"), P = require("./_push.js");

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 20000) throw new Error("too big"); }
  return JSON.parse(raw || "{}");
}
// The site's alert keys: made the first time they're needed, then kept in the database.
async function vapid() {
  const got = await S.one("GET", "tf:vapid");
  if (got) return JSON.parse(got);
  const k = P.newVapidKeys();
  const ok = await S.one("SET", "tf:vapid", JSON.stringify(k), "NX");
  return ok ? k : JSON.parse(await S.one("GET", "tf:vapid"));
}
const subjectOf = (req) => "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "trade-finder.vercel.app");
const okEndpoint = (u) => { try { return new URL(u).protocol === "https:"; } catch (e) { return false; } };

async function handler(req, res) {
  if (!S.config()) return send(res, 200, { configured: false });
  try {
    if (req.method === "GET") {
      const keys = await vapid(), live = Object.values(await S.hgetallJSON("tf:live")).sort((a, b) => a.t - b.t);
      return send(res, 200, { configured: true, publicKey: keys.publicKey, live });
    }
    if (req.method !== "POST") return send(res, 405, { error: "GET or POST" });
    const b = await readBody(req), ep = b.endpoint || (b.sub && b.sub.endpoint);
    if (!okEndpoint(ep)) return send(res, 400, { error: "bad subscription" });
    const cur = (await S.hgetallJSON("tf:subs"))[ep];
    if (b.action === "subscribe") {
      if (!b.sub || !b.sub.keys || !b.sub.keys.p256dh || !b.sub.keys.auth) return send(res, 400, { error: "bad subscription" });
      const tf = ["4H", "1H", "both"].includes(b.prefs && b.prefs.tf) ? b.prefs.tf : "4H";
      await S.hsetJSON("tf:subs", ep, { sub: { endpoint: ep, keys: { p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth } }, prefs: { tf }, alerts: (cur && cur.alerts) || [], at: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (b.action === "unsubscribe") { await S.hdel("tf:subs", ep); return send(res, 200, { ok: true }); }
    if (!cur) return send(res, 404, { error: "Turn on alerts first." });
    if (b.action === "alert") {
      const a = b.alert || {};
      if (!a.id || !a.sym || !(Number(a.level) > 0) || !["above", "below"].includes(a.dir)) return send(res, 400, { error: "bad alert" });
      cur.alerts = (cur.alerts || []).filter((x) => x.id !== a.id).concat([{ id: String(a.id).slice(0, 120), sym: String(a.sym).slice(0, 15), tf: a.tf, key: a.key, level: Number(a.level), dir: a.dir, label: String(a.label || "").slice(0, 80) }]).slice(-20);
      await S.hsetJSON("tf:subs", ep, cur);
      return send(res, 200, { ok: true, alerts: cur.alerts.length });
    }
    if (b.action === "unalert") { cur.alerts = (cur.alerts || []).filter((x) => x.id !== b.id); await S.hsetJSON("tf:subs", ep, cur); return send(res, 200, { ok: true }); }
    if (b.action === "test") {
      const r = await P.send(cur.sub, { title: "Trade Finder", body: "Alerts are on. You'll get new callouts here.", url: "/" }, await vapid(), subjectOf(req));
      return send(res, 200, { ok: r === "sent", result: r });
    }
    send(res, 400, { error: "unknown action" });
  } catch (e) { send(res, 500, { error: e.message || "failed" }); }
}

module.exports = handler;
module.exports.vapid = vapid;
module.exports.subjectOf = subjectOf;
