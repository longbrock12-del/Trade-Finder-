// Trade Finder - pattern study (tests only): groups replayed trades by what they looked like at entry and shows
// how each group did, for each setup. Not a Vercel function (file name starts with _).
// Each group: n trades, win %, average R, total R, and the same for the older part and the last 12 months
// (a pattern that only shows up in one of them is probably luck).
const r2 = (x) => Math.round(x * 100) / 100;
const KIND = (s) => (s === "bounce" ? "bounce" : s === "break & retest" ? "retest" : "break");
const BUCKETS = {
  trend: (x) => x.trend,
  grade: (x) => x.grade,
  dir: (x) => x.dir,
  taps: (x) => (x.taps >= 5 ? "5+" : String(x.taps)),
  nearMisses: (x) => (x.taps - x.real <= 0 ? "all real touches" : x.taps - x.real === 1 ? "1 near miss" : "2+ near misses"),
  stopDistATR: (x) => (x.riskAtr == null ? "?" : x.riskAtr < 0.75 ? "a <0.75" : x.riskAtr < 1.25 ? "b 0.75-1.25" : x.riskAtr < 2 ? "c 1.25-2" : "d 2+"),
  lineTF: (x) => x.lineTF,
  lineAgeDays: (x) => (x.days < 21 ? "a <21" : x.days < 60 ? "b 21-60" : x.days < 180 ? "c 60-180" : "d 180+"),
  angle: (x) => (x.angle < 15 ? "a <15°" : x.angle < 30 ? "b 15-30°" : "c 30°+"),
  stretch: (x) => (x.ext20 == null ? "?" : x.ext20 < -1 ? "a pulled back >1 ATR" : x.ext20 < 0 ? "b pulled back <1 ATR" : x.ext20 < 1 ? "c extended <1 ATR" : "d extended >1 ATR"),
  hourET: (x) => (x.hourET == null ? "?" : x.hourET >= 18 || x.hourET < 2 ? "a 6pm-2am" : x.hourET < 9 ? "b 2-9am" : x.hourET < 12 ? "c 9am-noon" : x.hourET < 16 ? "d noon-4pm" : "e 4-6pm"),
  weekday: (x) => x.wd,
  lateSafety: (x) => (x.late ? "safety line formed after" : "safety line at break"),
  signalCandle: (x) => (x.bodyAtr == null ? "?" : x.bodyAtr < 0 ? "a moved against the trade" : x.bodyAtr < 0.5 ? "b small (<0.5 ATR)" : x.bodyAtr < 1 ? "c medium (0.5-1 ATR)" : "d big (1+ ATR)"),
  closedAt: (x) => (x.closePos == null ? "?" : x.closePos < 0.33 ? "a weak end" : x.closePos < 0.67 ? "b middle" : "c strong end"),
  coilBefore: (x) => (x.squeezeAtr == null ? "?" : x.squeezeAtr < 2 ? "a tight (<2 ATR)" : x.squeezeAtr < 3.5 ? "b normal (2-3.5 ATR)" : "c wide (3.5+ ATR)"),
  approach: (x) => (x.approachAtr == null ? "?" : x.approachAtr < -1 ? "a ran the other way >1 ATR" : x.approachAtr < 0 ? "b drifted the other way" : x.approachAtr < 1 ? "c drifted the trade's way" : "d ran the trade's way >1 ATR"),
  pressure: (x) => (x.hugs == null ? "?" : x.hugs <= 1 ? "a 0-1 candles near the line" : x.hugs <= 4 ? "b 2-4 candles" : "c 5+ candles hugging it"),
  retestGap: (x) => (x.retestGap == null ? "n/a" : x.retestGap <= 3 ? "a 1-3 candles" : x.retestGap <= 8 ? "b 4-8 candles" : "c 9+ candles"),
};
function stats(arr) {
  const n = arr.length, w = arr.filter((x) => x.r > 0).length, tot = arr.reduce((a, x) => a + x.r, 0);
  return { n, win: n ? Math.round((100 * w) / n) : null, avg: n ? r2(tot / n) : null, tot: r2(tot) };
}
function summarize(list, now) {
  const cut = now - 365 * 86400, out = {};
  const kinds = ["all", "break", "retest", "bounce"];
  kinds.forEach((k) => {
    const L = k === "all" ? list : list.filter((x) => KIND(x.setup) === k);
    if (!L.length) return;
    const o = { overall: stats(L) };
    Object.entries(BUCKETS).forEach(([name, f]) => {
      const g = {};
      L.forEach((x) => { const b = f(x); (g[b] = g[b] || []).push(x); });
      o[name] = Object.fromEntries(Object.keys(g).sort().map((b) => {
        const s = stats(g[b]), old = stats(g[b].filter((x) => x.t < cut)), rec = stats(g[b].filter((x) => x.t >= cut));
        return [b, { ...s, older: [old.n, old.avg], last12: [rec.n, rec.avg] }];
      }));
    });
    out[k] = o;
  });
  return out;
}
module.exports = { summarize };
