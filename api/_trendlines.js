// Trade Finder - scanner for Tori Trades' trendline strategy, done her top-down way.
// Not a Vercel function (file name starts with _).
//
// Sources: her video "This boring trading strategy made me $526,454" (top-down analysis, action and safety
// lines, trailing the stop), her FX Replay checklist and the TradeZella playbook (A+ grading, bounces,
// "break must be close to the safety line").
//
// 1. Top-down lines. She starts on the monthly chart: the first rising line starts at the LOWEST point on the
//    chart, each next line starts where the last one ended ("previous point B is new point A"), each catches
//    as many touches as it can, and price may never poke through. Same for falling lines from the HIGHEST
//    point. Then weekly, daily, 4-hour, 1-hour: nudge the lines and add steeper ones near price.
//    Followed exactly, those rules give one chain of rising lines under all the lows and one chain of
//    falling lines over all the highs, each line steeper than the last. Built here from 10 years of daily
//    candles plus 6 months of hourly ones, so the old lines are the monthly/weekly ones and the newest are
//    4-hour/1-hour ones. Each line is labeled with the chart it shows up on, from how long it is.
// 2. Action line: the newest line in each chain (nearest price). A candle CLOSING through it is the entry,
//    in the direction of the break. Checked on 4-hour and 1-hour candles.
// 3. Safety line: the newest line of the other chain. The stop trails along it and the trade ends when a
//    candle closes through it. No fixed target (her video).
// 4. Bounce (TradeZella playbook): price tags the newest line and closes back on the right side. That line
//    is then the safety line.
// 5. Grade (FX Replay checklist), as a label only: A+ = 3+ taps, 6+ candles apart, under 45 degrees with
//    3 months on the chart, 3+ weeks from first tap to the break. Otherwise B.
// Numbers that are my reading of loose wording, not hers, are marked "my number".

const HOUR = 3600, DAY = 86400;
let MIN_GAP = 6;          // her rule: 6+ candles between taps; also the shortest line that counts as an action line
const MAX_ANGLE = 45;     // her rule: under 45 degrees with 3 months on the chart
const ASPECT = 1.8;       // my number: chart width / height of a normal screen, used to turn slope into degrees
const NEAR_ATR = 0.1;     // display only: a tap whose wick stops more than 0.1 ATR short of the line is drawn as a near miss
let TOUCH_ATR = 0.3;      // my number: how far a wick may poke THROUGH the line (closing back) and still be a tap
let HOLD = 2;            // a tap counts only if the next 2 candles don't close through the line (it held)
let SHORT_ATR = 0.3;      // how far SHORT of the line a wick may stop and still be a tap (0.05 = must actually touch; test with ?short=)
// Does a wick touch the line? under: a line under the lows (wick = the low); otherwise over the highs (wick = the high).
const touches = (w, v, a, under) => { const short = under ? w - v : v - w; return short <= SHORT_ATR * a && -short <= TOUCH_ATR * a; };
let FAR_ATR = 3;          // her "low-risk setup: price close to the safety line" - skip if risk is over this many ATR (test with ?far=)
const RETEST_MAX = 30;    // my number: how many candles after a break to wait for the retest
const TP_ZONE = 0.5;      // my number: swing highs/lows within 0.5 ATR count as the same level
const TP_BEFORE = 0.1;    // my number: take-profit set 0.1 ATR before the level ("a few points below", so it fills)
const STOP_ROOM = 0.5;    // my number: how far past the safety line the stop order sits (her rule: never on the line, always on the other side)
const MIN_PASSED = 3;      // your rule: a callout's line must pass at least 3 of the 4 checklist rules...
// ...and 3+ taps is always one of them (the replay showed 2-tap lines lost money; she prefers 3+ taps too).
// ...and the line must have at least a week of price data from first tap to the break (TradeZella playbook minimum).
const MIN_DAYS = 7;
const qualifies = (x) => x.passed >= MIN_PASSED && !!(x.checks && x.checks.taps) && x.days >= MIN_DAYS;
const WATCH_ATR = 1.5;    // my number: lines within 1.5 ATR of price go on the watch list
const RECENT_DAYS = 5;    // callouts from the last 5 trading days
const KEEP = 320;         // candles sent for the chart (enough to start at the line's first tap on most lines)
const CHART_AGE = 26 * 3600; // charts are sent only for live callouts this recent (the page shows ones under 24 hours old)
const ZOOM = 500;         // daily candles (about 2 years) for the zoomed-out chart
// Candles per trading day, for each chart: futures trade ~23 hours, stocks 6.5.
const PER_DAY = { futures: { "4H": 6, "1H": 23 }, stocks: { "4H": 2, "1H": 7 } };
// Dollars per 1.00 move for one contract, so callouts can show risk per contract.
// $ per 1.00 move, per contract. Micros: gold 10 oz, crude 100 bbl, silver 1,000 oz, copper 2,500 lb.
const POINT_VALUE = { "MGC=F": 10, "MCL=F": 100, "SIL=F": 1000, "MHG=F": 2500, "GC=F": 100, "CL=F": 1000, "SI=F": 5000, "HG=F": 25000 };

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
function et(ts) {
  const p = {};
  fmt.formatToParts(new Date(ts * 1000)).forEach((x) => { p[x.type] = x.value; });
  return { day: p.year + "-" + p.month + "-" + p.day, h: Number(p.hour) % 24, m: Number(p.minute), wd: p.weekday };
}

// Yahoo chart JSON -> bars [{t,o,h,l,c}]
function hourly(chart) {
  const r = chart && chart.chart && chart.chart.result && chart.chart.result[0];
  if (!r || !r.timestamp) return { meta: (r && r.meta) || {}, bars: [] };
  const q = r.indicators.quote[0], bars = [];
  r.timestamp.forEach((t, i) => {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if ([o, h, l, c].every((x) => typeof x === "number" && isFinite(x))) bars.push({ t, o, h, l, c });
  });
  return { meta: r.meta || {}, bars };
}

// Hourly -> 4-hour candles, cut the way TradingView cuts them.
// Futures: the session opens 6 PM New York time, so candles start 6 PM, 10 PM, 2 AM, 6 AM, 10 AM, 2 PM.
// Stocks: regular hours only, 9:30-1:30 and 1:30-4:00.
function fourHour(bars, isFuture, now) {
  const out = [];
  let cur = null;
  bars.forEach((b) => {
    let key, start, len;
    if (isFuture) {
      const s = et(b.t + 6 * HOUR), slot = Math.floor(s.h / 4);
      key = s.day + "#" + slot;
      start = b.t - ((s.h % 4) * HOUR + s.m * 60);
      len = 4 * HOUR;
    } else {
      const s = et(b.t), mins = s.h * 60 + s.m - 570;
      if (mins < 0 || mins >= 390) return;
      const slot = mins < 240 ? 0 : 1;
      key = s.day + "#" + slot;
      start = b.t - (mins - slot * 240) * 60;
      len = slot ? 150 * 60 : 4 * HOUR;
    }
    if (!cur || cur.key !== key) {
      cur = { key, t: start, end: start + len, o: b.o, h: b.h, l: b.l, c: b.c };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c;
    }
  });
  const last = out[out.length - 1];
  if (last && now < last.end) last.live = true; // still forming: never used for a signal
  return out.map((x) => ({ t: x.t, e: x.end, o: x.o, h: x.h, l: x.l, c: x.c, live: !!x.live }));
}

// Hourly candles as-is (stocks: regular hours only). The newest is "live" until its hour ends.
function oneHour(bars, isFuture, now) {
  const out = bars.filter((b) => { if (isFuture) return true; const s = et(b.t), m = s.h * 60 + s.m - 570; return m >= 0 && m < 390; })
    .map((b) => { const s = et(b.t); return { t: b.t, e: !isFuture && s.h * 60 + s.m === 930 ? b.t + 1800 : b.t + HOUR, o: b.o, h: b.h, l: b.l, c: b.c, live: false }; });
  const last = out[out.length - 1];
  if (last && now < last.e) last.live = true;
  return out;
}

function atr(b, n = 14) {
  const tr = b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l));
  const out = [];
  let s = 0;
  tr.forEach((v, i) => { s += v; if (i >= n) s -= tr[i - n]; out.push(s / Math.min(i + 1, n)); });
  return out;
}

// One chain of lines: lows from the lowest point (rising lines) or highs from the highest point (falling lines).
// Her three rules - lines connect, catch as many touches as possible, nothing pokes through - give exactly the
// lower (or upper) hull of the points from that start: each line rests on the extremes and is steeper than the
// one before. pts must be sorted by x: [{x, p, t}]. Returns the chain's corner points.
// Her drawing: points A and B sit on the real swing lows/highs, and a later wick that dips just under the line
// (no more than the tap distance, TOUCH_ATR) and closes back above doesn't move it; only a close through does.
// (BAC: A Apr 9 2025 33.07 -> B Nov 3 49.17, with Nov 6's 49.27 wick a hair under the line.) q.c = close,
// q.a = ATR at that candle. WICK_OK = false: the old rule (any wick under the line redraws it), for comparing.
let WICK_OK = process.env.TF_WICK !== "0", WICK_ATR = 0.03; // (TF_WICK=0: tests built on the old drawing) // how far (in ATR) a wick may dip under and leave the line alone
function wickOnly(o, a, q, up) { // q dips under the line o-a only by a wick (closes back on the right side)
  if (!WICK_OK || q.c == null || !(q.a > 0)) return false;
  const v = o.p + ((a.p - o.p) / (a.x - o.x)) * (q.x - o.x);
  const depth = up ? v - q.p : q.p - v; // how far the wick went through
  return depth > 0 && depth <= WICK_ATR * q.a && (up ? q.c >= v : q.c <= v);
}
function chain(pts, up) {
  if (pts.length < 2) return pts.slice();
  let s = 0;
  pts.forEach((q, i) => { if (up ? q.p <= pts[s].p : q.p >= pts[s].p) s = i; }); // latest lowest / highest point
  const st = [];
  for (let i = s; i < pts.length; i++) {
    const q = pts[i];
    let skip = false;
    while (st.length >= 2) {
      const o = st[st.length - 2], a = st[st.length - 1];
      const cr = (a.x - o.x) * (q.p - o.p) - (a.p - o.p) * (q.x - o.x);
      if (!(up ? cr <= 0 : cr >= 0)) break;
      if (wickOnly(o, a, q, up)) { skip = true; break; } // just a wick through this line: it stays
      st.pop();
    }
    if (!skip) st.push(q);
  }
  return st;
}

const lineOf = (a, b) => ({ a, b, slope: (b.p - a.p) / (b.x - a.x) });
const val = (ln, x) => ln.a.p + ln.slope * (x - ln.a.x);
// The action line: the newest line in the chain that runs from swing point to swing point ("point A is the
// pivot point"), is at least MIN_GAP candles long, and isn't flat. Newer corners that fail this sit above
// (or below) its extension, so skipping them never lets price poke through.
function active(corners) {
  for (let k = corners.length - 1; k >= 1; k--) {
    const a = corners[k - 1], b = corners[k], ln = lineOf(a, b);
    if (a.piv && b.piv && b.x - a.x >= MIN_GAP && ln.slope !== 0) return ln;
  }
  return null;
}

let PIVOT = 3;   // a swing point is the extreme of 3 candles each side (test with ?pivot=2)
function swings(bars) {
  const lo = new Array(bars.length).fill(false), hi = new Array(bars.length).fill(false);
  for (let i = PIVOT; i < bars.length - PIVOT; i++) {
    let l = true, h = true;
    for (let j = i - PIVOT; j <= i + PIVOT; j++) {
      if (j === i) continue;
      if (bars[j].l < bars[i].l) l = false;
      if (bars[j].h > bars[i].h) h = false;
    }
    lo[i] = l; hi[i] = h;
  }
  return { lo, hi };
}

// Which chart a line belongs to: by its length (point A to point B), but never smaller than the chart it was
// found on. Lines between two daily-candle swing points are at least Daily; lines found on the 4-hour chart are
// at least 4-hour (a 3-day line on a stock's 4-hour chart is still a 4-hour line, not a 1-hour one).
const TF_ORDER = ["1-hour", "4-hour", "Daily", "Weekly", "Monthly"];
function tfOfLine(ln, tf) {
  const d = (ln.b.t - ln.a.t) / DAY;
  let k = d >= 365 ? 4 : d >= 91 ? 3 : d >= 21 ? 2 : d >= 4 ? 1 : 0;
  if (ln.a.daily && ln.b.daily) k = Math.max(k, 2);
  if (tf === "4H") k = Math.max(k, 1);
  return TF_ORDER[k];
}

// Everything for one entry chart (4H or 1H): the merged daily + intraday points and a way to get the two
// chains as they stood before any candle.
function setup(daily, bars, isFuture, tf) {
  const ppd = PER_DAY[isFuture ? "futures" : "stocks"][tf];
  const dayOf = (t) => (isFuture ? et(t + 6 * HOUR).day : et(t).day);
  const first = dayOf(bars[0].t);
  const D = daily.filter((d) => et(d.t).day < first);
  const x0 = D.length * ppd;
  const dSw = swings(D), iSw = swings(bars);
  const A = atr(bars), dA = atr(D.length ? D : bars);
  const dPts = (key) => D.map((d, k) => ({ x: k * ppd, p: d[key], c: d.c, a: dA[k], t: d.t, daily: true, piv: (key === "l" ? dSw.lo : dSw.hi)[k] }));
  // Only the daily hull corners can matter, so keep just those.
  const dUp = chain(dPts("l"), true), dDn = chain(dPts("h"), false);
  function chainsBefore(i) { // chains from everything up to candle i-1
    const make = (dHull, key, up) => {
      const intra = [];
      const sw = up ? iSw.lo : iSw.hi; // a swing needs its 3 candles after to be finished before candle i
      for (let j = 0; j < i; j++) intra.push({ x: x0 + j, p: bars[j][key], c: bars[j].c, a: A[j], t: bars[j].t, piv: sw[j] && j + PIVOT < i });
      const ps = intra.map((q) => q.p), m = ps.length ? (up ? Math.min(...ps) : Math.max(...ps)) : null;
      const dm = dHull.length ? dHull[0].p : null;
      const intraWins = dm == null || (m != null && (up ? m < dm : m > dm));
      return chain(intraWins ? intra : dHull.concat(intra), up);
    };
    return { up: make(dUp, "l", true), dn: make(dDn, "h", false) };
  }
  // The action lines as they stood before each candle (act[i]), built one candle at a time: the same chains
  // chainsBefore() makes, without rebuilding them for every candle. act[bars.length] = after the last candle.
  const act = new Array(bars.length + 1), st = { up: dUp.slice(), dn: dDn.slice() };
  const ext = { up: dUp.length ? dUp[0].p : null, dn: dDn.length ? dDn[0].p : null }, sws = { up: iSw.lo, dn: iSw.hi };
  const pivAt = (q, i) => (q.daily ? q.piv : sws[q.side][q.j] && q.j + PIVOT < i);
  const activeAt = (c, i) => {
    for (let k = c.length - 1; k >= 1; k--) {
      const a = c[k - 1], b = c[k];
      if (b.p !== a.p && b.x - a.x >= MIN_GAP && pivAt(a, i) && pivAt(b, i)) return lineOf(a, b);
    }
    return null;
  };
  const add = (side, q) => {
    const up = side === "up";
    if (ext[side] == null || (up ? q.p <= ext[side] : q.p >= ext[side])) { st[side] = [q]; ext[side] = q.p; return; } // new extreme: chain restarts
    const c = st[side];
    while (c.length >= 2) {
      const o = c[c.length - 2], a = c[c.length - 1], cr = (a.x - o.x) * (q.p - o.p) - (a.p - o.p) * (q.x - o.x);
      if (!(up ? cr <= 0 : cr >= 0)) break;
      if (wickOnly(o, a, q, up)) return; // just a wick through this line: it stays (same as chain())
      c.pop();
    }
    c.push(q);
  };
  for (let i = 0; i <= bars.length; i++) {
    act[i] = { up: activeAt(st.up, i), dn: activeAt(st.dn, i) };
    if (i < bars.length) {
      add("up", { x: x0 + i, p: bars[i].l, c: bars[i].c, a: A[i], t: bars[i].t, j: i, side: "up" });
      add("dn", { x: x0 + i, p: bars[i].h, c: bars[i].c, a: A[i], t: bars[i].t, j: i, side: "dn" });
    }
  }
  return { tf, ppd, D, x0, A, dA, bars, chainsBefore, act };
}

// Taps on a line from its start up to (not including) candle `upto`: candles whose wick actually touches it (see touches()):
// the line, the extreme of their neighbors, 6+ candles apart. Daily history counts each day as one tap spot.
// all: every candle whose wick touched the line (for the chart's dots), without the hold and 6-candle rules
// that decide which taps count.
function taps(S, ln, upto, up, all) {
  const key = up ? "l" : "h", out = [];
  // Candles in order (daily ones before the intraday ones), so a tap can be checked against the candles after it.
  const seq = S.D.map((d, k) => ({ x: k * S.ppd, c: d.c })).concat(S.bars.slice(0, upto).map((b, i) => ({ x: S.x0 + i, c: b.c })));
  const pos = new Map(seq.map((q, n) => [q.x, n]));
  // A tap has to hold: the next HOLD candles don't close through the line (price touched it and turned away).
  // A touch the break starts from right away is part of the break, not a tap.
  const held = (x) => {
    if (!HOLD) return true;
    const n = pos.get(x);
    if (n == null || n + HOLD >= seq.length) return false;
    for (let j = n + 1; j <= n + HOLD; j++) { const v = val(ln, seq[j].x); if (up ? seq[j].c < v : seq[j].c > v) return false; }
    return true;
  };
  const consider = (x, p, tol, ext) => {
    if (x < ln.a.x - 0.01 || !ext || !touches(p, val(ln, x), tol, up)) return;
    if (all) { out.push(x); return; }
    if (!held(x)) return;
    if (out.length && x - out[out.length - 1] < MIN_GAP) return;
    out.push(x);
  };
  S.D.forEach((d, k) => {
    const lo = Math.max(0, k - 2), hi = Math.min(S.D.length - 1, k + 2);
    let ext = true;
    for (let j = lo; j <= hi; j++) if (up ? S.D[j].l < d.l : S.D[j].h > d.h) ext = false;
    consider(k * S.ppd, d[key], S.dA[k], ext);
  });
  for (let i = 0; i < upto; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(upto - 1, i + 2);
    let ext = true;
    for (let j = lo; j <= hi; j++) if (up ? S.bars[j].l < S.bars[i].l : S.bars[j].h > S.bars[i].h) ext = false;
    consider(S.x0 + i, S.bars[i][key], S.A[i], ext);
  }
  return out;
}

function angleOf(slope, S, last) {
  const b = S.bars, from = b[last].t - 91 * DAY;
  let n = 0, hi = -Infinity, lo = Infinity;
  for (let i = last; i >= 0 && b[i].t >= from; i--) { n++; hi = Math.max(hi, b[i].h); lo = Math.min(lo, b[i].l); }
  const range = hi - lo || 1;
  return (Math.atan((Math.abs(slope) * n) / range / ASPECT) * 180) / Math.PI;
}

function grade(S, ln, i, up) {
  const tp = taps(S, ln, i, up), days = (S.bars[i].t - ln.a.t) / DAY, angle = angleOf(ln.slope, S, i);
  const checks = { taps: tp.length >= 3, spacing: true, angle: angle < MAX_ANGLE, history: days >= 21 };
  const passed = Object.values(checks).filter(Boolean).length; // out of 4
  return { grade: passed === 4 ? "A+" : "B", passed, checks, taps: tp.length, real: tp.filter((x) => !nearMiss(S, ln, x)).length, tapX: tp, days: Math.round(days), angle: Math.round(angle) };
}
// A near miss: the wick came within the tap distance but stopped more than NEAR_ATR short of the line (it never
// reached it). Everything else is a real touch. x is in merged candle space (daily candles before x0).
function nearMiss(S, ln, x) {
  const d = x < S.x0, k = d ? Math.round(x / S.ppd) : x - S.x0, c = d ? S.D[k] : S.bars[k], a = d ? S.dA[k] : S.A[k], v = val(ln, x);
  return (ln.slope > 0 ? c.l - v : v - c.h) > NEAR_ATR * a;
}

// Walk a trade forward. Her exits: the stop order sits just past the safety line ("never on the safety line,
// always on the other side") and trails along it; and the trade ends when a finished candle closes through
// the safety line. Both trail along the newest line of the safety chain and never loosen.
// line0: safety line value at entry; room: distance of the stop order past the line.
// tpPx: also take profit when a candle reaches that price (exit=tp test), or a moving price, candle by candle
// (exit "htf": a bigger-timeframe trendline, the futures' live exit).
// sl0: the safety line at entry. src = the line the current stop level came from (what the chart draws and Tracking
// names), which stays the same when a newer line in the chain would be looser.
// KEEP_LINE: the safety line in use keeps trailing down (or up) its own slope every candle, until a candle CLOSES
// through it (the exit). A wick that pokes through doesn't stop it (HOOD: Nov 23's 70.24 wick above the Nov 11-19
// line used to freeze the stop at 71.38 instead of following the line to about 68 by Nov 24). A newer, tighter line
// still takes over. KEEP_LINE = false: the old way (the stop only moved with the newest line), for comparing.
let KEEP_LINE = true;
function follow(S, long, from, last, line0, room, tpPx, sl0) {
  let line = line0, stop = long ? line0 - room : line0 + room, src = sl0 || null;
  const keep = (i) => { // the line in use, carried on along its slope
    if (!KEEP_LINE || !src) return;
    const v = val(src, S.x0 + i);
    line = long ? Math.max(line, v) : Math.min(line, v); stop = long ? Math.max(stop, v - room) : Math.min(stop, v + room);
  };
  for (let i = from + 1; i <= last; i++) {
    keep(i);
    const sl = long ? S.act[i].up : S.act[i].dn;
    if (sl) { const v = val(sl, S.x0 + i); if (long ? v > line : v < line) src = sl; line = long ? Math.max(line, v) : Math.min(line, v); stop = long ? Math.max(stop, v - room) : Math.min(stop, v + room); }
    const c = S.bars[i];
    if (long ? c.l <= stop : c.h >= stop) return { status: "closed", at: i, px: long ? Math.min(c.o, stop) : Math.max(c.o, stop), stop, line, how: "stop order" }; // a gap past the stop fills at the open
    const tg = typeof tpPx === "function" ? tpPx(i) : tpPx;
    if (tg != null && (long ? c.h >= tg : c.l <= tg)) return { status: "closed", at: i, px: long ? Math.max(c.o, tg) : Math.min(c.o, tg), stop, line, how: "take profit" };
    if (long ? c.c < line : c.c > line) return { status: "closed", at: i, px: c.c, stop, line, how: "close through the line" };
  }
  keep(last + 1);
  const sl = long ? S.act[last + 1].up : S.act[last + 1].dn;
  if (sl) { const v = val(sl, S.x0 + last + 1); if (long ? v > line : v < line) src = sl; line = long ? Math.max(line, v) : Math.min(line, v); stop = long ? Math.max(stop, v - room) : Math.min(stop, v + room); }
  return { status: "open", stop, line, safety: src || sl };
}

// All callouts on one entry chart from candle `from` to `last`.
function events(S, from, last) {
  const out = [], b = S.bars;
  for (let i = Math.max(2, from); i <= last; i++) {
    const { up, dn } = S.act[i], x = S.x0 + i;
    // Breaks: this candle closes through the newest line; the one before hadn't.
    [[up, false], [dn, true]].forEach(([ln, long]) => {
      if (!ln) return;
      const v = val(ln, x), pv = val(ln, x - 1);
      if (long ? !(b[i].c > v && b[i - 1].c <= pv) : !(b[i].c < v && b[i - 1].c >= pv)) return;
      out.push({ kind: "break", long, at: i, action: ln, safety: long ? up : dn });
      // Break and retest (her newer setup): after the break, price pulls back and touches the line from the other
      // side, and that candle closes still respecting it. Enter on that close. Watch up to RETEST_MAX candles; a
      // close back through the line cancels it.
      for (let j = i + 1; j <= Math.min(last, i + RETEST_MAX); j++) {
        const vj = val(ln, S.x0 + j), c = b[j];
        if (long ? c.c < vj : c.c > vj) break;
        if (long ? c.l <= vj + SHORT_ATR * S.A[j] : c.h >= vj - SHORT_ATR * S.A[j]) { // the pullback actually touches the line
          out.push({ kind: "retest", long, at: j, brk: i, action: ln, safety: long ? S.act[j].up : S.act[j].dn });
          break;
        }
      }
    });
    // Bounces: wick tags the newest line, candle closes back on the right side, line already has 2+ taps.
    [[up, true], [dn, false]].forEach(([ln, long]) => {
      if (!ln) return;
      const v = val(ln, x), w = long ? b[i].l : b[i].h;
      if (!touches(w, v, S.A[i], long) || (long ? b[i].c <= v : b[i].c >= v)) return;
      const tp = taps(S, ln, i - 2, long);
      if (tp.length < 2) return;
      // A fresh tap: the line wasn't touched in the 6 candles before (her 6+ candles between taps).
      for (let j = Math.max(0, i - MIN_GAP); j < i; j++) if (touches(long ? b[j].l : b[j].h, val(ln, S.x0 + j), S.A[j], long)) return;
      out.push({ kind: "bounce", long, at: i, action: ln, safety: ln });
    });
  }
  return out;
}

const g0 = (x) => (x == null ? null : x);
const r2 = (x, a) => (x == null ? null : Number(x.toFixed(a)));
const WARMUP = 30; // candles before the replay starts (ATR and swing points need some history)

// One callout from one event: grade, entry, safety line, starting stop, and how it has gone since.
function callout(s, e, last, live, px) {
  const b = s.bars, tf = s.tf;
  const g = grade(s, e.action, e.brk != null ? e.brk : e.at, e.kind === "bounce" ? e.long : !e.long); // graded at the break; rising line under lows?
  const entry = b[e.at].c;
  const c = { tf, setup: e.kind === "bounce" ? "bounce" : e.kind === "retest" ? "break & retest" : g.taps >= 3 ? "3-touch break" : "2-touch break", dir: e.long ? "long" : "short",
    at: e.at, t: b[e.at].t, entry: px(entry), grade: g.grade, passed: g.passed, checks: g.checks, taps: g.taps, real: g.real, days: g.days, angle: g.angle,
    lineTF: tfOfLine(e.action, tf), lineFrom: e.action.a.t, action: e.action, tapX: g.tapX };
  let sl = e.safety, from = e.at;
  if (!sl) {
    // Her rule: no safety line yet - wait for one to form, then enter if price is still past the action line.
    for (let j = e.at + 1; j <= last && !sl; j++) {
      const cand = e.long ? s.act[j].up : s.act[j].dn, still = e.long ? b[j].c > val(e.action, s.x0 + j) : b[j].c < val(e.action, s.x0 + j);
      if (cand && still) { sl = cand; from = j; }
    }
    if (!sl) return { ...c, status: "no-safety", note: "No safety line yet. Wait for a clear swing " + (e.long ? "low" : "high") + " to form, then draw one." };
    c.late = true; c.entry = px(b[from].c);
  }
  const ent = b[from].c, line0 = val(sl, s.x0 + from), room = STOP_ROOM * s.A[from];
  const stop0 = e.long ? line0 - room : line0 + room, risk = e.long ? ent - stop0 : stop0 - ent;
  if (!(risk > 0) || (e.long ? ent <= line0 : ent >= line0)) return { ...c, status: "no-safety", note: "The safety line is on the wrong side of the entry." };
  // exit=tp test: her take-profit, set at entry from the candles up to then (no peeking ahead).
  const mode = s.exit || null; // "htf" (futures), "tp" (test), none = trail only
  const tpAt = mode === "tp" ? takeProfit(s, e.long, ent, ent, from) : null;
  const htf = mode === "htf" || mode === "htfsr" ? htfTarget(s, e.long, from, ent, (s.tmin || 0) * risk) : null;
  // exit=htfsr / sr tests: her other exit, a support/resistance level price has turned at 4+ times, using only the
  // daily candles before the entry day (the same levels the charts draw). htfsr = whichever comes first.
  let srP = null, srN = null;
  if ((mode === "htfsr" || mode === "sr") && s.lvDaily) {
    // srmin (R): skip levels closer to the entry than that (a level a few cents away isn't a target).
    const lv = srLevels(s.lvDaily.filter((d) => d.t < b[from].t - DAY), ent).filter((v) => (e.long ? v.p > ent : v.p < ent) && Math.abs(v.p - ent) >= (s.srMin || 0) * risk).sort((p, q) => Math.abs(p.p - ent) - Math.abs(q.p - ent))[0];
    if (lv) { srP = lv.p; srN = lv.n; }
  }
  const tgtAt = htf || srP != null ? (i) => {
    const a = htf ? val(htf, s.x0 + i) : null;
    if (a == null) return srP; if (srP == null) return a;
    return e.long ? Math.min(a, srP) : Math.max(a, srP);
  } : null;
  const out = follow(s, e.long, from, last, line0, room, tpAt ? tpAt.price : tgtAt, sl);
  // Which target the trade exited at: the bigger-timeframe trendline (its chart and its two points) or the S/R level.
  let exitTo = null;
  if (out.how === "take profit" && !tpAt) {
    const lineV = htf ? val(htf, s.x0 + out.at) : null, bySr = srP != null && (lineV == null || (e.long ? srP <= lineV : srP >= lineV));
    exitTo = bySr ? { kind: "sr", price: px(srP), touches: srN } : { kind: "line", tf: tfOfLine(htf, tf), price: px(lineV), t0: htf.a.t, p0: px(htf.a.p), t1: htf.b.t, p1: px(htf.b.p) };
  }
  const far = risk > FAR_ATR * s.A[from];
  const sign = e.long ? 1 : -1;
  const tp = out.status === "open" ? takeProfit(s, e.long, live, ent, last) : null;
  return { ...c, from, stop0: px(stop0), risk: px(risk), stop: px(out.stop), line: px(out.line), exitHow: out.how || null, safety: out.safety || sl,
    tp: tp && { price: px(tp.price), touches: tp.touches, r: r2(((e.long ? 1 : -1) * (tp.price - ent)) / risk, 1) },
    // The live target: the nearer of the bigger-timeframe line (as it stands now) and the S/R level.
    target: (htf || srP != null) && out.status === "open" && !far ? (() => {
      const lineV = htf ? val(htf, s.x0 + last + 1) : null, useSr = srP != null && (lineV == null || (e.long ? srP < lineV : srP > lineV)), p = useSr ? srP : lineV;
      return { price: px(p), tf: useSr ? "S/R" : tfOfLine(htf, tf), ...(useSr ? { touches: srN } : {}), r: r2(((e.long ? 1 : -1) * (p - ent)) / risk, 1) };
    })() : null,
    entryT: b[from].e, exitT: out.at == null ? null : b[out.at].e, entryRaw: ent, riskRaw: risk, exitTo,
    status: far ? "too-far" : out.status, closedAt: out.at, exitPx: px(out.px), exitR: out.px == null ? null : r2((sign * (out.px - ent)) / risk, 2),
    nowR: r2((sign * (live - ent)) / risk, 2), liveThrough: out.status === "open" && (e.long ? live < out.stop : live > out.stop),
    note: far ? "Break closed too far from the safety line (risk over " + FAR_ATR + " ATR). Her rule: skip it." : c.late ? "Safety line formed after the break. Entry is that later close." : null };
}

// Strong support/resistance levels for the charts: prices where the market turned 3+ times over about 2 years
// of daily candles. Swing highs and swing lows both count (old resistance often becomes support). Nearby turns
// (a zone at most about 0.6 of a day's ATR wide) are the same level. Up to 3 above and 3 below price, the most-touched first.
// Strong support/resistance: price zones where the market turned (a confirmed daily swing high or low) 4+ times
// over all the daily history we have (~10 years). Only the ones that matter to a trade are kept: still in play
// (price turned there in the last ~2 years) and the 2 nearest above and 2 nearest below today's price, the first
// places a trade would stall or bounce.
const SR_MIN = 4, SR_RECENT = 500, SR_EACH = 2;
// How a support/resistance level has done each time price came back to it (daily candles, all the history we have):
// held = price reached the zone (within 0.35 ATR) and turned away 1+ ATR without a daily close through it;
// fake = a daily close through it, but price was back on the original side within 20 days;
// broke = a close through it that stayed through (the level's job ended there; old resistance can become support).
// Only for the few levels the charts show, so it costs next to nothing.
function srHistory(D, p) {
  const A = atr(D), out = { tests: 0, held: 0, fake: 0, broke: 0, lastBreak: null };
  let i = 1;
  while (i < D.length) {
    const z = 0.35 * A[i], prev = D[i - 1].c;
    if (Math.abs(prev - p) <= z) { i++; continue; } // already sitting on the level: wait to see a side
    const above = prev > p, reach = above ? D[i].l <= p + z : D[i].h >= p - z;
    if (!reach) { i++; continue; }
    out.tests++;
    let j = i, res = null;
    for (; j < Math.min(D.length, i + 15); j++) {
      const a = A[j];
      if (above ? D[j].c < p - 0.35 * a : D[j].c > p + 0.35 * a) { res = "through"; break; }
      if (above ? D[j].h >= p + a : D[j].l <= p - a) { res = "held"; break; }
    }
    if (res === "held") { out.held++; i = j + 1; continue; }
    if (res === "through") {
      let k = j + 1, back = false;
      for (; k < Math.min(D.length, j + 21); k++) if (above ? D[k].c > p : D[k].c < p) { back = true; break; }
      if (back) { out.fake++; i = k + 1; } else { out.broke++; out.lastBreak = D[j].t; i = j + 21; }
      continue;
    }
    out.tests--; // still undecided (the latest days): don't count it yet
    break;
  }
  return out;
}

function srLevels(daily, live) {
  const D = daily;
  if (D.length < 30) return [];
  const sw = swings(D), A = atr(D)[D.length - 1], pts = [];
  D.forEach((d, i) => { if (sw.hi[i]) pts.push({ p: d.h, i }); if (sw.lo[i]) pts.push({ p: d.l, i }); });
  pts.sort((a, b) => a.p - b.p);
  const groups = [];
  pts.forEach((x) => { const g = groups[groups.length - 1]; if (g && x.p - g[0].p <= 0.6 * A) g.push(x); else groups.push([x]); }); // a level is at most ~half a day's range wide
  const lv = groups.filter((g) => g.length >= SR_MIN && Math.max(...g.map((x) => x.i)) >= D.length - SR_RECENT)
    .map((g) => ({ p: g.reduce((a, x) => a + x.p, 0) / g.length, n: g.length }));
  const near = (side) => lv.filter(side).sort((a, b) => Math.abs(a.p - live) - Math.abs(b.p - live)).slice(0, SR_EACH);
  return near((x) => x.p >= live).concat(near((x) => x.p < live)).map((x) => ({ p: x.p, n: x.n, side: x.p >= live ? "R" : "S" }));
}

// Her optional take-profit (for quick wins instead of trailing): the nearest support/resistance in the trade's
// direction with as many touches as possible, close to current price, set slightly before the level.
// Levels = clusters of swing highs (for longs) or lows (for shorts) on this chart over the last 3 months.
// exit=htf test: her other exit, "price got to a higher time frame trendline". For a long, the nearest
// Daily/Weekly/Monthly falling line above the entry (an older, flatter line of the falling chain, extended);
// for a short, the nearest rising one below. Taken from the chains as they stood at entry.
// minDist (tests: tmin, in R): skip lines closer than that to the entry.
function htfTarget(s, long, from, entry, minDist = 0) {
  const ch = s.chainsBefore(from + 1), c = long ? ch.dn : ch.up, x = s.x0 + from;
  let best = null, bestV = null;
  // Only real trendlines, like every other line she trades: both points confirmed swing points, 6+ candles apart
  // (not a line ending at the newest low that isn't a swing yet). rules.realLines = false turns it off (tests).
  for (let k = 1; k < c.length; k++) {
    const ln = lineOf(c[k - 1], c[k]);
    if (!ln.slope || TF_ORDER.indexOf(tfOfLine(ln, s.tf)) < 2) continue;
    if (s.realLines && !(c[k - 1].piv && c[k].piv && c[k].x - c[k - 1].x >= MIN_GAP)) continue;
    const v = val(ln, x);
    if (long ? v > entry + minDist && (bestV == null || v < bestV) : v < entry - minDist && (bestV == null || v > bestV)) { best = ln; bestV = v; }
  }
  return best;
}

function takeProfit(s, long, price, entry, last) {
  const b = s.bars, sw = swings(b), A = s.A[last], from = b[last].t - 91 * DAY, pts = [];
  price = long ? Math.max(price, entry) : Math.min(price, entry); // the target must be past both price and entry
  for (let i = 0; i <= last - PIVOT; i++) {
    if (b[i].t < from) continue;
    if (long && sw.hi[i] && b[i].h > price) pts.push(b[i].h);
    if (!long && sw.lo[i] && b[i].l < price) pts.push(b[i].l);
  }
  pts.sort((p, q) => (long ? p - q : q - p)); // nearest first
  const groups = [];
  pts.forEach((p) => { const g = groups[groups.length - 1]; if (g && Math.abs(p - g[0]) <= TP_ZONE * A) g.push(p); else groups.push([p]); });
  const g = groups.find((x) => x.length >= 2); // nearest level price has turned at 2+ times
  if (!g) return null;
  const edge = long ? Math.min(...g) : Math.max(...g);
  return { price: long ? edge - TP_BEFORE * A : edge + TP_BEFORE * A, touches: g.length };
}

// Track record: every callout you'd have taken over the window (3+ of 4 checklist rules, not skipped),
// one position per market. A newer callout replaces the one you're in at its entry price, like the page shows;
// otherwise a trade ends on its safety line. R = profit in multiples of the starting risk.
// w (tests only): cost = R taken off every trade (commissions, slippage, option spreads); from/to = count only
// trades entered in that window (the positions are still worked out over the whole replay).
function record(hist, w = {}) {
  const rank = (x) => (x.tf === "4H" ? 0 : 6) + (x.grade === "A+" ? 0 : 3) + (x.setup === "bounce" ? 2 : x.setup === "break & retest" ? 1 : 0);
  const take = hist.filter((x) => qualifies(x) && (x.status === "open" || x.status === "closed"))
    .sort((p, q) => p.entryT - q.entryT || rank(p) - rank(q));
  const done = [];
  let pos = null;
  take.forEach((x) => {
    if (pos && x.entryT === pos.entryT) return; // two charts at once: keep the first (higher-ranked) one
    if (pos) {
      if (pos.exitT != null && pos.exitT <= x.entryT) done.push({ ...pos, r: pos.exitR, how: pos.exitHow === "take profit" ? "target line" : "safety line" });
      else done.push({ ...pos, r: r2(((pos.dir === "long" ? 1 : -1) * (x.entryRaw - pos.entryRaw)) / pos.riskRaw, 2), how: "replaced", exitT: x.entryT });
    }
    pos = x;
  });
  let open = null;
  if (pos) { if (pos.exitT != null) done.push({ ...pos, r: pos.exitR, how: pos.exitHow === "take profit" ? "target line" : "safety line" }); else open = pos; }
  if (w.cost || w.from != null || w.to != null) {
    const kept = done.filter((x) => (w.from == null || x.entryT >= w.from) && (w.to == null || x.entryT < w.to)).map((x) => ({ ...x, r: r2(x.r - (w.cost || 0), 2) }));
    done.length = 0; done.push(...kept);
    if (open && w.to != null && open.entryT >= w.to) open = null;
  }
  const rs = done.map((x) => x.r), tot = rs.reduce((a, r) => a + r, 0);
  // Size of wins and losses, and how long each was held (raw sums, so markets can be added together).
  const W = done.filter((x) => x.r > 0), Ls = done.filter((x) => x.r <= 0), hrs = (x) => Math.max(0, (x.exitT - x.entryT) / 3600);
  const kindOf = (x) => (x.setup === "bounce" ? "bounce" : x.setup === "break & retest" ? "retest" : "break");
  const bySetup = {};
  done.forEach((x) => { const k = kindOf(x), b2 = (bySetup[k] = bySetup[k] || { trades: 0, wins: 0, totalR: 0 }); b2.trades++; if (x.r > 0) b2.wins++; b2.totalR = r2(b2.totalR + x.r, 2); });
  const sizes = { bySetup, nWin: W.length, nLoss: Ls.length, winSum: r2(W.reduce((a, x) => a + x.r, 0), 2), lossSum: r2(-Ls.reduce((a, x) => a + x.r, 0), 2),
    winHrs: Math.round(W.reduce((a, x) => a + hrs(x), 0)), lossHrs: Math.round(Ls.reduce((a, x) => a + hrs(x), 0)) };
  let peak = 0, run = 0, dd = 0;
  rs.forEach((r) => { run += r; peak = Math.max(peak, run); dd = Math.min(dd, run - peak); });
  return {
    from: take.length ? take[0].entryT : null, trades: done.length, wins: rs.filter((r) => r > 0).length,
    totalR: r2(tot, 2), avgR: done.length ? r2(tot / done.length, 2) : null, bestR: rs.length ? Math.max(...rs) : null, worstR: rs.length ? Math.min(...rs) : null,
    maxDrawdownR: r2(dd, 2), openR: open ? open.nowR : null, ...sizes,
    recent: done.slice(-10).reverse().map((x) => ({ t: x.entryT, out: x.exitT, tf: x.tf, dir: x.dir, setup: x.setup, grade: x.grade, r: x.r, how: x.how })),
    // list=1 (pattern study): every trade with what it looked like at entry.
    ...(w.list ? { list: done.map((x) => ({ t: x.entryT, out: x.exitT, dir: x.dir, setup: x.setup, grade: x.grade, passed: x.passed, taps: x.taps, real: x.real, days: x.days, angle: x.angle, lineTF: x.lineTF, r: x.r, how: x.how, ...(x.feat || {}) })) } : {}),
  };
}

// exit "htfsr" (futures, her exits exactly): take profit at the nearest bigger-timeframe (Daily, Weekly, Monthly)
// trendline or support/resistance level (4+ turns), whichever price reaches first; else the safety line.
// Target lines are real trendlines only (swing point to swing point, 6+ candles). 2 years: +22.5% on the three futures.
// srMin 0.5: an S/R level only counts as a target if it's at least half the risk past the entry (not a level a few
// cents away, like BAC's 49.26 support 19 cents under a 49.45 short).
const FUTURE_RULES = { trend: "bounce", once: false, setups: null, exit: "htfsr", srMin: 0.5 };
// Stocks: exactly her strategy, the same as gold and copper (all three setups, bounces with the trend; exits at the
// trailing stop / safety line, an S/R level or a bigger-timeframe line). One set of rules for everything; tweaks
// get tested from here.
// Exactly her strategy on stocks too (she traded stocks this way when she started). 2 years, 112 stocks: -40% (bounces
// -43% over 268 trades; breaks and retests about even), so stock callouts are setups to check, not a proven edge.
const STOCK_RULES = { ...FUTURE_RULES };
// Crude (MCL/CL): her own crude trades are all breaks and break & retests ("I'm a breakout trader"); crude
// bounces lost money over 2 years. And she gets out before the contract switches, so no new crude callouts
// in the 4 trading days up to the front contract's last day.
const CRUDE_RULES = { trend: "bounce", once: false, setups: ["break", "retest"], rollBlackout: true, exit: "htfsr", srMin: 0.5 };
const isCrude = (sym) => /^M?CL=F$/.test(sym || "");
// Crude's last trading day for the contract that expires in this month: 3 business days before the 25th
// (4 if the 25th is a weekend day). Holidays aren't counted.
function crudeLastDay(y, m) {
  const biz = (d) => { const w = d.getUTCDay(); return w !== 0 && w !== 6; };
  const d = new Date(Date.UTC(y, m, 25));
  let n = biz(d) ? 3 : 4;
  while (n > 0) { d.setUTCDate(d.getUTCDate() - 1); if (biz(d)) n--; }
  return d;
}
// Trading days from this day to the front contract's last day (0 = the last day itself), or null after it.
function crudeDaysLeft(day) {
  const [y, mo, dd] = day.split("-").map(Number), last = crudeLastDay(y, mo - 1), d = new Date(Date.UTC(y, mo - 1, dd));
  if (d > last) return null;
  let n = 0;
  for (const q = new Date(last); q > d; q.setUTCDate(q.getUTCDate() - 1)) { const w = q.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
// True on the last day and the 3 trading days before it.
function nearCrudeRoll(day) {
  const [y, mo, dd] = day.split("-").map(Number), last = crudeLastDay(y, mo - 1), d = new Date(Date.UTC(y, mo - 1, dd));
  if (d > last) return false;
  let n = 0;
  for (const q = new Date(last); q > d; q.setUTCDate(q.getUTCDate() - 1)) { const w = q.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n <= 3;
}

// Her top-down trend (her playbook: "a top-down look at bigger timeframes, like the daily or weekly, helps
// confirm the main trend direction"; "ranging markets provide few valid opportunities"). Clean structure:
// the last two swing highs AND the last two swing lows both rising = uptrend, both falling = downtrend,
// anything else = no clear trend. Weekly chart first; if it has no clear trend, the Daily. Only finished
// candles count (a swing needs 2 finished candles after it), so the replay never looks ahead.
// Returns trendAt(t) -> { dir: "up" | "down" | null, from: "Weekly" | "Daily" | null }.
function trendSeries(daily) {
  const DAY_S = 86400;
  const weeks = [];
  daily.forEach((d) => {
    const wk = Math.floor((Math.floor(d.t / DAY_S) + 3) / 7); // Monday-based weeks
    const w = weeks[weeks.length - 1];
    if (w && w.wk === wk) { w.h = Math.max(w.h, d.h); w.l = Math.min(w.l, d.l); w.end = d.t; }
    else weeks.push({ wk, t: d.t, end: d.t, h: d.h, l: d.l });
  });
  const series = (bars) => {
    const out = [], hi = [], lo = [];
    for (let j = 0; j < bars.length; j++) {
      const i = j - 2; // a swing at i is confirmed once candle i+2 has finished
      if (i >= 2) {
        const b = bars[i];
        if (bars[i - 1].h < b.h && bars[i - 2].h < b.h && bars[i + 1].h <= b.h && bars[i + 2].h <= b.h) hi.push(b.h);
        if (bars[i - 1].l > b.l && bars[i - 2].l > b.l && bars[i + 1].l >= b.l && bars[i + 2].l >= b.l) lo.push(b.l);
      }
      let dir = null;
      if (hi.length >= 2 && lo.length >= 2) {
        const hh = hi[hi.length - 1] > hi[hi.length - 2], hl = lo[lo.length - 1] > lo[lo.length - 2];
        const lh = hi[hi.length - 1] < hi[hi.length - 2], ll = lo[lo.length - 1] < lo[lo.length - 2];
        dir = hh && hl ? "up" : lh && ll ? "down" : null;
      }
      out.push({ known: (bars[j].end || bars[j].t) + DAY_S, dir }); // usable from the day after the candle closes
    }
    return out;
  };
  const W = series(weeks), D = series(daily);
  const at = (arr, t) => { let lo = 0, hi = arr.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].known <= t) { k = m; lo = m + 1; } else hi = m - 1; } return k < 0 ? null : arr[k].dir; };
  return (t) => { const w = at(W, t); if (w) return { dir: w, from: "Weekly" }; const d = at(D, t); return d ? { dir: d, from: "Daily" } : { dir: null, from: null }; };
}

// hChart: Yahoo hourly bars (6 months). dChart: Yahoo daily bars (10 years).
function scanCore(hChart, dChart, opts = {}) {
  const now = opts.now || Date.now() / 1000;
  const { meta, bars: hb } = hourly(hChart);
  const sym = opts.sym || meta.symbol;
  const isFuture = (meta.instrumentType || "").toUpperCase() === "FUTURE" || /=F$/.test(sym || "");
  const daily = hourly(dChart).bars;
  // The 1-hour chart is only built when asked for (?tf=1H|both): the site runs on the 4-hour chart, and
  // building it was about a quarter of every scan's work.
  const sets = {
    "4H": fourHour(hb, isFuture, now),
    "1H": !opts.tfs || opts.tfs.includes("1H") ? oneHour(hb, isFuture, now) : [],
  };
  if (sets["4H"].length < 60) return { sym, error: "not enough price history" };
  const live = hb[hb.length - 1].c, ref = sets["4H"][sets["4H"].length - 1].c;
  const tick = ref >= 1000 ? 1 : ref >= 50 ? 2 : ref >= 1 ? 3 : 5;
  const px = (x) => r2(x, tick);
  const all = [], watch = [], S = {};
  // Support/resistance comes from the longest clean daily history: a micro's full-size contract (same prices,
  // trading since long before the micros started in 2021) when it's given, else this market's own.
  let lvDaily = daily;
  try { if (opts.levelDaily) { const b = hourly(opts.levelDaily).bars; if (b.length > daily.length) lvDaily = b; } } catch (e) {}
  const LEVELS = srLevels(lvDaily, live).map((x) => ({ ...x, ...srHistory(lvDaily, x.p), p: px(x.p) }));

  const hist = []; // every callout over the whole window, for the track record
  // Which setups and filters each kind of market uses (opts.rules overrides any of them, for tests):
  //   futures: exactly her strategy: all three setups; bounces go with her top-down trend ("price is in an uptrend"),
  //            breaks don't need it (her playbook: a break "indicates a trend reversal").
  //   stocks:  her strategy, but only the setup with the best win rate on stocks: breaks (34% on 112 stocks
  //            over 6 months, vs 20% break & retest and 16% bounces).
  //   trend: true = every setup goes with the trend, "bounce" = bounces only, false = off.
  //   once: one attempt per trendline for breaks (FX Replay's added rule, not hers: off by default).
  const R = { ...(isFuture ? (isCrude(sym) ? CRUDE_RULES : FUTURE_RULES) : STOCK_RULES), ...(opts.rules || {}) };
  const trendAt = trendSeries(daily), useTrend = R.trend !== false, trendMode = R.trend, useOnce = R.once === true, setupsOk = R.setups;
  // opts.tfs: which charts to take callouts from (the site uses 4-hour by default). The 4-hour chart is always
  // set up, since the 3-month chart view uses it.
  Object.keys(sets).forEach((tf) => {
    const b = sets[tf], use = !opts.tfs || opts.tfs.includes(tf);
    if (b.length < 30 || (!use && tf !== "4H")) return;
    const s = (S[tf] = setup(daily, b, isFuture, tf));
    s.exit = R.exit || null; s.tmin = R.tmin || 0; s.lvDaily = lvDaily; s.realLines = R.realLines !== false; s.srMin = R.srMin || 0;
    const last = b[b.length - 1].live ? b.length - 2 : b.length - 1;
    s.last = last;
    if (!use) return;
    const recentFrom = last - RECENT_DAYS * s.ppd + 1;
    const tried = new Set(); // trendlines whose break has already been traded (one attempt per line)
    events(s, opts.history === false ? recentFrom : WARMUP, last).forEach((e) => {
      if (setupsOk && !setupsOk.includes(e.kind)) return; // stocks: retests only; crude: breaks and retests
      if (R.rollBlackout && nearCrudeRoll(et(b[e.at].t + 6 * HOUR).day)) return; // crude: contract switch coming up
      // against the trend, or choppy (rules.trend === "bounce": only bounces need the trend; breaks are reversals)
      if (useTrend && (trendMode !== "bounce" || e.kind === "bounce")) { const tr = trendAt(b[e.at].t); if (tr.dir !== (e.long ? "up" : "down")) return; }
      const c = callout(s, e, last, live, px);
      if (opts.tradeList) { // pattern study (tests): what each trade looked like when it was taken
        const tr = trendAt(b[e.at].t), from = c.from != null ? c.from : e.at, A = s.A[from] || s.A[e.at];
        c.feat = { trend: tr.dir ? (tr.dir === (e.long ? "up" : "down") ? "with" : "against") : "none", riskAtr: c.riskRaw ? r2(c.riskRaw / A, 2) : null,
          hourET: et(b[from].t).h, wd: et(b[from].t).wd, lineDays: g0(c.days), slopeAtr: r2(Math.abs(e.action.slope) / A, 3), late: !!c.late,
          ext20: r2((b[from].c - b.slice(Math.max(0, from - 20), from + 1).reduce((a, q) => a + q.c, 0) / Math.min(21, from + 1)) / A * (e.long ? 1 : -1), 2) };
        // What price did right before the entry (the signal candle and the candles leading into it).
        const k = e.at, q = b[k], sg = e.long ? 1 : -1, rng = q.h - q.l || 1e-9, pre = b.slice(Math.max(0, k - 10), k);
        Object.assign(c.feat, {
          bodyAtr: r2((sg * (q.c - q.o)) / A, 2),                                  // signal candle: + = moved the trade's way
          closePos: r2(e.long ? (q.c - q.l) / rng : (q.h - q.c) / rng, 2),            // 1 = closed at the trade's end of the candle
          squeezeAtr: pre.length ? r2((Math.max(...pre.map((x) => x.h)) - Math.min(...pre.map((x) => x.l))) / A, 2) : null, // range of the 10 candles before
          approachAtr: k >= 6 ? r2((sg * (b[k - 1].c - b[k - 6].c)) / A, 2) : null, // last 5 candles: + = already moving the trade's way
          hugs: pre.filter((x, j) => Math.abs(x.c - val(e.action, s.x0 + k - pre.length + j)) <= 0.5 * A).length, // candles closing near the line
          retestGap: e.brk != null ? k - e.brk : null,                               // candles from the break to the retest
        });
      }
      if (useOnce && e.kind !== "bounce" && qualifies(c)) {
        const k = e.action.a.t + ":" + e.action.b.t;
        if (tried.has(k)) return;
        tried.add(k);
      }
      hist.push(c);
      if (e.at >= recentFrom) all.push(c);
    });
    // Watch list: the newest line of each chain, if price is close to it.
    [[s.act[last + 1].up, true], [s.act[last + 1].dn, false]].forEach(([ln, up]) => {
      if (!ln) return;
      const v = val(ln, s.x0 + last + 1), d = Math.abs(live - v) / s.A[last];
      if (d > WATCH_ATR) return;
      const g = grade(s, ln, last + 1 > b.length - 1 ? b.length - 1 : last + 1, up);
      if (!qualifies(g)) return; // only lines that would make a real callout if price breaks or bounces off them
      watch.push({ tf, grade: g.grade, passed: g.passed, checks: g.checks, taps: g.taps, real: g.real, days: g.days, angle: g.angle, lineTF: tfOfLine(ln, tf), key: ln.a.t + ":" + ln.b.t,
        line: { t0: ln.a.t, p0: ln.a.p, t1: ln.b.t, p1: ln.b.p, up, d0: ln.a.x < s.x0, d1: ln.b.x < s.x0 },
        _ln: ln, _safety: up ? s.act[last + 1].dn : s.act[last + 1].up, _tapX: g.tapX,
        kind: up ? "rising line under lows" : "falling line over highs", lineNow: px(v), dist: r2(d, 1),
        plan: up ? tf + " close below " + px(v) + " = short break. Tag and hold = long bounce." : tf + " close above " + px(v) + " = long break. Tag and reject = short bounce." });
    });
  });

  // Only callouts whose line passes at least 3 of the 4 checklist rules, 3+ taps always. Of those, one per market: the newest.
  // Same time: 4-hour before 1-hour, A+ before B, break before bounce. (opts.all: every callout, for tests.)
  const rank = (x) => (x.tf === "4H" ? 0 : 6) + (x.grade === "A+" ? 0 : 3) + (x.setup === "bounce" ? 2 : x.setup === "break & retest" ? 1 : 0);
  all.sort((p, q) => q.t - p.t || rank(p) - rank(q));
  const fit = all.filter(qualifies);
  fit.forEach((x) => { if (fit.some((y) => y !== x && y.t === x.t && y.dir !== x.dir)) x.mixed = true; });
  const sigs = opts.all ? all : fit.slice(0, 1);
  if (!opts.all && fit.length > 1) sigs[0].replaced = fit.length - 1;
  const seen = new Set(), wl = [];
  watch.sort((p, q) => (p.tf === q.tf ? p.dist - q.dist : p.tf === "4H" ? -1 : 1)).forEach((w) => { if (!seen.has(w.key)) { seen.add(w.key); wl.push(w); } });

  // Chart data for each callout: the last KEEP candles of its chart, lines in that window's candle numbers.
  const chartFor = (x) => {
    const s = S[x.tf], b = s.bars, end = s.last + (b[b.length - 1].live ? 1 : 0), off = Math.max(0, end + 1 - KEEP), base = s.x0 + off;
    // t0/t1: the times of point A and point B, so the line can be redrawn on TradingView.
    // d0/d1: the point is on a daily candle (older than the 4-hour data), so only its date matters.
    const loc = (ln) => ln && { i0: ln.a.x - base, p0: ln.a.p, slope: ln.slope, i1: ln.b.x - base, p1: ln.b.p, t0: ln.a.t, t1: ln.b.t, d0: ln.a.x < s.x0, d1: ln.b.x < s.x0 };
    const ch = s.chainsBefore(s.last + 1);
    // Only real trendlines: swing point to swing point, 6+ candles, not flat (the same rule as action lines).
    // The short pieces in between would draw as a bend, and they're never traded.
    // Every line's own taps (the same tap rules as the action line), so the chart can mark them all.
    // i: candle on this chart (negative = before it), X: daily-candle units for the 3-month and 2-year views.
    const zoff0 = Math.max(0, daily.length - ZOOM);
    // Every touch, so each line shows a dot wherever price touched it (the action line's counted taps stay in taps).
    const tapsOf = (ln, up) => taps(s, ln, s.last + 1, up, true).map((q) => ({ i: q - base, X: q / s.ppd - zoff0, p: px(val(ln, q)), near: nearMiss(s, ln, q) }));
    const edges = (c, up) => c.slice(1).map((q, k) => [c[k], q])
      .filter(([a, q]) => a.piv && q.piv && q.x - a.x >= MIN_GAP && q.p !== a.p)
      .map(([a, q]) => ({ up, ...loc(lineOf(a, q)), taps: tapsOf(lineOf(a, q), up) })).filter((e) => e.i1 >= -KEEP);
    // Every real line in both chains, Monthly down to 1-hour, with where its ray sits now.
    // X = position in daily candles (the merged x divided by candles per day), for the zoomed-out daily chart.
    const xNow = s.x0 + s.last + 1, same = (ln, o) => !!o && ln.a.t === o.a.t && ln.b.t === o.b.t;
    const zoff = Math.max(0, daily.length - ZOOM);
    const info = (ln, up) => {
      const v = val(ln, xNow);
      return { up, tf: tfOfLine(ln, x.tf), t0: ln.a.t, p0: ln.a.p, t1: ln.b.t, p1: ln.b.p, now: px(v), pct: r2((100 * (v - live)) / live, 1),
        action: same(ln, x.action), safety: same(ln, x.safety), X0: ln.a.x / s.ppd - zoff, P0: ln.a.p, slopeX: ln.slope * s.ppd,
        taps: tapsOf(ln, up).map((q) => ({ X: q.X, p: q.p, near: q.near })) };
    };
    const lines = [[ch.up, true], [ch.dn, false]].flatMap(([c, up]) => c.slice(1).map((q, k) => [c[k], q])
      .filter(([a, q]) => a.piv && q.piv && q.x - a.x >= MIN_GAP && q.p !== a.p)
      .map(([a, q]) => info(lineOf(a, q), up)));
    // The callout's own action and safety lines, even if the chains have moved on since it fired.
    [[x.action, "action"], [x.safety, "safety"]].forEach(([ln, k]) => {
      if (ln && !lines.some((l) => l[k])) lines.push({ ...info(ln, ln.slope > 0), atCallout: true });
    });
    return {
      bars: b.slice(off).map((q) => [q.t, px(q.o), px(q.h), px(q.l), px(q.c)]),
      line: loc(x.action), safety: loc(x.safety),
      lineTouches: x.action ? tapsOf(x.action, x.action.slope > 0) : [], safetyTouches: x.safety ? tapsOf(x.safety, x.safety.slope > 0) : [], tapIdx: x.tapX.map((t) => t - base).filter((t) => t >= 0),
      // Every tap on the action line, including ones older than this chart: when (t), where on the line (p),
      // and X in daily-candle units for the 3-month and 2-year views.
      // near: the wick came within the tap distance but stopped more than 0.1 ATR short of the line (a near
      // miss, shown hollow); otherwise it reached or crossed the line (a real touch, shown solid).
      taps: x.action ? x.tapX.map((q) => {
        const d = q < s.x0, k = d ? Math.round(q / s.ppd) : q - s.x0, c = d ? s.D[k] : s.bars[k], a = d ? s.dA[k] : s.A[k], v = val(x.action, q), up = x.action.slope > 0;
        return { t: c.t, p: px(v), X: q / s.ppd - zoff, near: nearMiss(s, x.action, q) };
      }) : [],
      at: x.at - off, from: x.from == null ? null : x.from - off, closedAt: x.closedAt == null ? null : x.closedAt - off,
      chains: edges(ch.up, true).concat(edges(ch.dn, false)),
      levels: LEVELS,
      lines, zoom: daily.slice(zoff).map((q) => [q.t, px(q.o), px(q.h), px(q.l), px(q.c)]),
      // Middle view: about 3 months of 4-hour candles. X of candle k = X0 + k * dX (same daily-candle units as the lines).
      mid: (() => {
        const s4 = S["4H"], b4 = s4.bars, f4 = Math.max(0, b4.findIndex((q) => q.t >= b4[b4.length - 1].t - 91 * DAY));
        return { bars: b4.slice(f4).map((q) => [q.t, px(q.o), px(q.h), px(q.l), px(q.c)]), X0: (s4.x0 + f4) / s4.ppd - zoff, dX: 1 / s4.ppd };
      })(),
    };
  };
  // Chart data is most of the download, so it's only sent for trades the page can show (live, fired in the
  // last ~day). opts.all (tests) keeps it for every callout.
  // Watch-list charts (only when asked: /api/trades?wchart=1, one stock at a time): the same chart a callout
  // gets, with the watched line as the thick line, the newest line on the other side as the dashed one.
  wl.forEach((w) => {
    if (opts.watchCharts) w.chart = chartFor({ tf: w.tf, action: w._ln, safety: w._safety || null, tapX: w._tapX || [], at: S[w.tf].last, from: null, closedAt: null });
    delete w._ln; delete w._safety; delete w._tapX;
  });
  // Look up (/api/trades?look=1, one market): the 4-hour chart around whichever of the two newest lines is nearer
  // to price, with every line and its taps, whether or not it's on the watch list.
  // Futures always get this too (without the chart): the watch list always shows every futures market with its nearest line.
  let look = null;
  if ((opts.lookup || isFuture) && S["4H"]) {
    const s = S["4H"], i = s.last + 1, ends = [[s.act[i].up, true], [s.act[i].dn, false]].filter(([ln]) => ln);
    if (ends.length) {
      const [ln, up] = ends.sort((p, q) => Math.abs(val(p[0], s.x0 + i) - live) - Math.abs(val(q[0], s.x0 + i) - live))[0];
      const other = up ? s.act[i].dn : s.act[i].up, g = grade(s, ln, Math.min(i, s.bars.length - 1), up), v = val(ln, s.x0 + i);
      look = { tf: "4H", lineTF: tfOfLine(ln, "4H"), up, lineNow: px(v), dist: r2(Math.abs(live - v) / s.A[s.last], 1), grade: g.grade, passed: g.passed, checks: g.checks, taps: g.taps, real: g.real, days: g.days, angle: g.angle,
        line: { t0: ln.a.t, p0: ln.a.p, t1: ln.b.t, p1: ln.b.p, d0: ln.a.x < s.x0, d1: ln.b.x < s.x0 }, // its points A and B
        chart: opts.lookup ? chartFor({ tf: "4H", action: ln, safety: other || null, tapX: g.tapX, at: s.last, from: null, closedAt: null }) : null };
    }
  }
  // A callout the site sent earlier (opts.tradeAt = { t, dir }: its time and direction), with its chart, for the
  // tracking box. Found in the 6-month replay, which makes the same callouts.
  let trade = null;
  if (opts.tradeAt) {
    const x = hist.find((c) => c.t === opts.tradeAt.t && c.dir === opts.tradeAt.dir);
    if (x) { trade = { ...x, chart: chartFor(x) }; ["action", "safety", "tapX", "from", "entryRaw", "riskRaw"].forEach((k) => delete trade[k]); }
  }
  const clean = (x) => {
    const o = { ...x, chart: opts.all || (x.status === "open" && now - x.t <= CHART_AGE) ? chartFor(x) : null };
    ["action", "safety", "tapX", "from", "entryRaw", "riskRaw"].forEach((k) => delete o[k]);
    return o;
  };
  const b4 = sets["4H"], l4 = b4[b4.length - 1].live ? b4.length - 2 : b4.length - 1, prev = b4[Math.max(0, l4 - 6)].c;
  return {
    sym, name: meta.shortName || meta.longName || sym, kind: isFuture ? "futures" : "stocks",
    pointValue: POINT_VALUE[sym] || null, price: px(live), chg: r2(((b4[l4].c - prev) / prev) * 100, 2), digits: tick,
    dailyBars: daily.length, trend: trendAt(now), ...(isFuture ? { spark: b4.slice(Math.max(0, l4 - 29), l4 + 1).map((q) => px(q.c)) } : {}), signals: sigs.map(clean), watch: wl.slice(0, 4), ...(look ? { look } : {}), ...(trade ? { trade } : {}), record: opts.history === false ? null : record(hist, { cost: R.cost || 0, list: !!opts.tradeList }),
    // ?split=1 (tests): the same record for the older part of the replay and for the last 12 months.
    ...(opts.split ? { split: { older: record(hist, { cost: R.cost || 0, to: now - 365 * DAY }), last12: record(hist, { cost: R.cost || 0, from: now - 365 * DAY }) } } : {}),
  };
}

// opts.rules (tests only, e.g. /api/scan?touch=0.15): run the replay with a different tap distance (touch, in ATR)
// or shortest line (gap, in candles). Put back right after; scanning is synchronous, so nothing else sees them.
function scan(hChart, dChart, opts = {}) {
  if (!opts.rules) return scanCore(hChart, dChart, opts);
  const saved = [TOUCH_ATR, MIN_GAP, SHORT_ATR, HOLD, PIVOT, FAR_ATR, WICK_OK, WICK_ATR, KEEP_LINE];
  try {
    if (opts.rules.touch != null) TOUCH_ATR = opts.rules.touch;
    if (opts.rules.gap != null) MIN_GAP = opts.rules.gap;
    if (opts.rules.short != null) SHORT_ATR = opts.rules.short;
    if (opts.rules.hold != null) HOLD = opts.rules.hold;
    if (opts.rules.pivot != null) PIVOT = opts.rules.pivot;
    if (opts.rules.far != null) FAR_ATR = opts.rules.far;
    if (opts.rules.wick != null) { WICK_OK = !!opts.rules.wick; if (opts.rules.wick > 0 && opts.rules.wick !== true && opts.rules.wick !== 1) WICK_ATR = opts.rules.wick; } // ?wick=0: the old drawing; ?wick=0.1: allowance in ATR
    if (opts.rules.keep != null) KEEP_LINE = !!opts.rules.keep; // ?keep=0: the old trailing (only the newest line moves the stop)
    return scanCore(hChart, dChart, opts);
  } finally { [TOUCH_ATR, MIN_GAP, SHORT_ATR, HOLD, PIVOT, FAR_ATR, WICK_OK, WICK_ATR, KEEP_LINE] = saved; }
}

const setWick = (on) => { WICK_OK = !!on; }; // tests: switch the live drawing on or off
module.exports = { setWick, srHistory, nearCrudeRoll, crudeLastDay, crudeDaysLeft, trendSeries, scan, fourHour, oneHour, hourly, atr, chain, active, setup, record };
