// Trade Finder - tiny client for the Upstash Redis database Vercel connects to the project (Storage tab).
// Uses its REST API, so nothing to install. Not a Vercel function (file name starts with _).
// Env vars come from the Vercel integration: KV_REST_API_URL / KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_*).
function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

// Run several commands in one request: redis([["GET","k"],["SET","k","v"]]) -> [result, result]
async function redis(cmds) {
  const c = config();
  if (!c) throw new Error("no database");
  const r = await fetch(c.url + "/pipeline", {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { Authorization: "Bearer " + c.token, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error("database " + r.status);
  const out = await r.json();
  return out.map((x) => (x && x.error ? null : x && x.result));
}
const one = async (...cmd) => (await redis([cmd]))[0];

// Hash of JSON values: all as an object, or set/delete one field.
async function hgetallJSON(key) {
  const flat = (await one("HGETALL", key)) || [];
  const o = {};
  for (let i = 0; i + 1 < flat.length; i += 2) { try { o[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* skip bad rows */ } }
  return o;
}
const hsetJSON = (key, field, val) => one("HSET", key, field, JSON.stringify(val));
const hdel = (key, field) => one("HDEL", key, field);

module.exports = { config, redis, one, hgetallJSON, hsetJSON, hdel };
