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
const MIN_GAP = 6;        // her rule: 6+ candles between taps; also the shortest line that counts as an action line
const MAX_ANGLE = 45;     // her rule: under 45 degrees with 3 months on the chart
const ASPECT = 1.8;       // my number: chart width / height of a normal screen, used to turn slope into degrees
const TOUCH_ATR = 0.3;    // my number: a wick within 0.3 ATR of the line counts as a tap
const FAR_ATR = 3;        // my number: "break must be close to the safety line" - skip if risk is over 3 ATR
const BOUNCE_ROOM = 0.5;  // my number: room below a bounce line for wicks, used for the risk number
const MIN_PASSED = 3;      // your rule: a callout's line must pass at least 3 of the 4 checklist rules
const WATCH_ATR = 1.5;    // my number: lines within 1.5 ATR of price go on the watch list
const RECENT_DAYS = 5;    // callouts from the last 5 trading days
const KEEP = 150;         // candles sent for the chart
const ZOOM = 500;         // daily candles (about 2 years) for the zoomed-out chart
// Candles per trading day, for each chart: futures trade ~23 hours, stocks 6.5.
const PER_DAY = { futures: { "4H": 6, "1H": 23 }, stocks: { "4H": 2, "1H": 7 } };
// Dollars per 1.00 move for one contract, so callouts can show risk per contract.
const POINT_VALUE = { "MGC=F": 10, "MCL=F": 100, "GC=F": 100, "CL=F": 1000 };

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
function chain(pts, up) {
  if (pts.length < 2) return pts.slice();
  let s = 0;
  pts.forEach((q, i) => { if (up ? q.p <= pts[s].p : q.p >= pts[s].p) s = i; }); // latest lowest / highest point
  const st = [];
  for (let i = s; i < pts.length; i++) {
    const q = pts[i];
    while (st.length >= 2) {
      const o = st[st.length - 2], a = st[st.length - 1];
      const cr = (a.x - o.x) * (q.p - o.p) - (a.p - o.p) * (q.x - o.x);
      if (up ? cr <= 0 : cr >= 0) st.pop(); else break;
    }
    st.push(q);
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

const PIVOT = 3; // a swing point is the extreme of 3 candles each side
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
  const dPts = (key) => D.map((d, k) => ({ x: k * ppd, p: d[key], t: d.t, daily: true, piv: (key === "l" ? dSw.lo : dSw.hi)[k] }));
  // Only the daily hull corners can matter, so keep just those.
  const dUp = chain(dPts("l"), true), dDn = chain(dPts("h"), false);
  const A = atr(bars), dA = atr(D.length ? D : bars);
  function chainsBefore(i) { // chains from everything up to candle i-1
    const make = (dHull, key, up) => {
      const intra = [];
      const sw = up ? iSw.lo : iSw.hi; // a swing needs its 3 candles after to be finished before candle i
      for (let j = 0; j < i; j++) intra.push({ x: x0 + j, p: bars[j][key], t: bars[j].t, piv: sw[j] && j + PIVOT < i });
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
      if (up ? cr <= 0 : cr >= 0) c.pop(); else break;
    }
    c.push(q);
  };
  for (let i = 0; i <= bars.length; i++) {
    act[i] = { up: activeAt(st.up, i), dn: activeAt(st.dn, i) };
    if (i < bars.length) {
      add("up", { x: x0 + i, p: bars[i].l, t: bars[i].t, j: i, side: "up" });
      add("dn", { x: x0 + i, p: bars[i].h, t: bars[i].t, j: i, side: "dn" });
    }
  }
  return { tf, ppd, D, x0, A, dA, bars, chainsBefore, act };
}

// Taps on a line from its start up to (not including) candle `upto`: candles whose wick is within TOUCH_ATR of
// the line, the extreme of their neighbors, 6+ candles apart. Daily history counts each day as one tap spot.
function taps(S, ln, upto, up) {
  const key = up ? "l" : "h", out = [];
  const consider = (x, p, tol, ext) => {
    if (x < ln.a.x - 0.01 || !ext || Math.abs(p - val(ln, x)) > tol) return;
    if (out.length && x - out[out.length - 1] < MIN_GAP) return;
    out.push(x);
  };
  S.D.forEach((d, k) => {
    const lo = Math.max(0, k - 2), hi = Math.min(S.D.length - 1, k + 2);
    let ext = true;
    for (let j = lo; j <= hi; j++) if (up ? S.D[j].l < d.l : S.D[j].h > d.h) ext = false;
    consider(k * S.ppd, d[key], TOUCH_ATR * S.dA[k], ext);
  });
  for (let i = 0; i < upto; i++) {
    const lo = Math.max(0, i - 2), hi = Math.min(upto - 1, i + 2);
    let ext = true;
    for (let j = lo; j <= hi; j++) if (up ? S.bars[j].l < S.bars[i].l : S.bars[j].h > S.bars[i].h) ext = false;
    consider(S.x0 + i, S.bars[i][key], TOUCH_ATR * S.A[i], ext);
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
  return { grade: passed === 4 ? "A+" : "B", passed, checks, taps: tp.length, tapX: tp, days: Math.round(days), angle: Math.round(angle) };
}

// Walk a trade forward. The stop trails along the newest line of the safety chain (never loosening) and the
// trade ends when a finished candle closes through it.
function follow(S, long, from, last, stop0) {
  let stop = stop0;
  for (let i = from + 1; i <= last; i++) {
    const sl = long ? S.act[i].up : S.act[i].dn;
    if (sl) { const v = val(sl, S.x0 + i); stop = long ? Math.max(stop, v) : Math.min(stop, v); }
    if (long ? S.bars[i].c < stop : S.bars[i].c > stop) return { status: "closed", at: i, px: S.bars[i].c, stop };
  }
  const sl = long ? S.act[last + 1].up : S.act[last + 1].dn;
  if (sl) { const v = val(sl, S.x0 + last + 1); stop = long ? Math.max(stop, v) : Math.min(stop, v); }
  return { status: "open", stop, safety: sl };
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
    });
    // Bounces: wick tags the newest line, candle closes back on the right side, line already has 2+ taps.
    [[up, true], [dn, false]].forEach(([ln, long]) => {
      if (!ln) return;
      const v = val(ln, x), w = long ? b[i].l : b[i].h;
      if (Math.abs(w - v) > TOUCH_ATR * S.A[i] || (long ? b[i].c <= v : b[i].c >= v)) return;
      const tp = taps(S, ln, i - 2, long);
      if (tp.length < 2) return;
      // A fresh tap: the line wasn't touched in the 6 candles before (her 6+ candles between taps).
      for (let j = Math.max(0, i - MIN_GAP); j < i; j++) if (Math.abs((long ? b[j].l : b[j].h) - val(ln, S.x0 + j)) <= TOUCH_ATR * S.A[j]) return;
      out.push({ kind: "bounce", long, at: i, action: ln, safety: ln });
    });
  }
  return out;
}

const r2 = (x, a) => (x == null ? null : Number(x.toFixed(a)));
const WARMUP = 30; // candles before the replay starts (ATR and swing points need some history)

// One callout from one event: grade, entry, safety line, starting stop, and how it has gone since.
function callout(s, e, last, live, px) {
  const b = s.bars, tf = s.tf;
  const g = grade(s, e.action, e.at, e.kind === "bounce" ? e.long : !e.long); // rising line under lows?
  const entry = b[e.at].c;
  const c = { tf, setup: e.kind === "bounce" ? "bounce" : g.taps >= 3 ? "3-touch break" : "2-touch break", dir: e.long ? "long" : "short",
    at: e.at, t: b[e.at].t, entry: px(entry), grade: g.grade, passed: g.passed, checks: g.checks, taps: g.taps, days: g.days, angle: g.angle,
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
  const ent = b[from].c, line0 = val(sl, s.x0 + from), room = e.kind === "bounce" ? BOUNCE_ROOM * s.A[from] : 0;
  const stop0 = e.long ? line0 - room : line0 + room, risk = e.long ? ent - stop0 : stop0 - ent;
  if (!(risk > 0)) return { ...c, status: "no-safety", note: "The safety line is on the wrong side of the entry." };
  const out = follow(s, e.long, from, last, stop0);
  const far = risk > FAR_ATR * s.A[from];
  const sign = e.long ? 1 : -1;
  return { ...c, from, stop0: px(stop0), risk: px(risk), stop: px(out.stop), safety: out.safety || sl,
    entryT: b[from].e, exitT: out.at == null ? null : b[out.at].e, entryRaw: ent, riskRaw: risk,
    status: far ? "too-far" : out.status, closedAt: out.at, exitPx: px(out.px), exitR: out.px == null ? null : r2((sign * (out.px - ent)) / risk, 2),
    nowR: r2((sign * (live - ent)) / risk, 2), liveThrough: out.status === "open" && (e.long ? live < out.stop : live > out.stop),
    note: far ? "Break closed too far from the safety line (risk over " + FAR_ATR + " ATR). Her rule: skip it." : c.late ? "Safety line formed after the break. Entry is that later close." : null };
}

// Track record: every callout you'd have taken over the window (3+ of 4 checklist rules, not skipped),
// one position per market. A newer callout replaces the one you're in at its entry price, like the page shows;
// otherwise a trade ends on its safety line. R = profit in multiples of the starting risk.
function record(hist) {
  const rank = (x) => (x.tf === "4H" ? 0 : 4) + (x.grade === "A+" ? 0 : 2) + (x.setup === "bounce" ? 1 : 0);
  const take = hist.filter((x) => x.passed >= MIN_PASSED && (x.status === "open" || x.status === "closed"))
    .sort((p, q) => p.entryT - q.entryT || rank(p) - rank(q));
  const done = [];
  let pos = null;
  take.forEach((x) => {
    if (pos && x.entryT === pos.entryT) return; // two charts at once: keep the first (higher-ranked) one
    if (pos) {
      if (pos.exitT != null && pos.exitT <= x.entryT) done.push({ ...pos, r: pos.exitR, how: "safety line" });
      else done.push({ ...pos, r: r2(((pos.dir === "long" ? 1 : -1) * (x.entryRaw - pos.entryRaw)) / pos.riskRaw, 2), how: "replaced", exitT: x.entryT });
    }
    pos = x;
  });
  let open = null;
  if (pos) { if (pos.exitT != null) done.push({ ...pos, r: pos.exitR, how: "safety line" }); else open = pos; }
  const rs = done.map((x) => x.r), tot = rs.reduce((a, r) => a + r, 0);
  let peak = 0, run = 0, dd = 0;
  rs.forEach((r) => { run += r; peak = Math.max(peak, run); dd = Math.min(dd, run - peak); });
  return {
    from: take.length ? take[0].entryT : null, trades: done.length, wins: rs.filter((r) => r > 0).length,
    totalR: r2(tot, 2), avgR: done.length ? r2(tot / done.length, 2) : null, bestR: rs.length ? Math.max(...rs) : null, worstR: rs.length ? Math.min(...rs) : null,
    maxDrawdownR: r2(dd, 2), openR: open ? open.nowR : null,
    recent: done.slice(-10).reverse().map((x) => ({ t: x.entryT, out: x.exitT, tf: x.tf, dir: x.dir, setup: x.setup, grade: x.grade, r: x.r, how: x.how })),
  };
}

// hChart: Yahoo hourly bars (6 months). dChart: Yahoo daily bars (10 years).
function scan(hChart, dChart, opts = {}) {
  const now = opts.now || Date.now() / 1000;
  const { meta, bars: hb } = hourly(hChart);
  const sym = opts.sym || meta.symbol;
  const isFuture = (meta.instrumentType || "").toUpperCase() === "FUTURE" || /=F$/.test(sym || "");
  const daily = hourly(dChart).bars;
  const sets = {
    "4H": fourHour(hb, isFuture, now),
    "1H": oneHour(hb, isFuture, now),
  };
  if (sets["4H"].length < 60) return { sym, error: "not enough price history" };
  const live = hb[hb.length - 1].c, ref = sets["4H"][sets["4H"].length - 1].c;
  const tick = ref >= 1000 ? 1 : ref >= 50 ? 2 : ref >= 1 ? 3 : 5;
  const px = (x) => r2(x, tick);
  const all = [], watch = [], S = {};

  const hist = []; // every callout over the whole window, for the track record
  Object.keys(sets).forEach((tf) => {
    const b = sets[tf];
    if (b.length < 30) return;
    const s = (S[tf] = setup(daily, b, isFuture, tf));
    const last = b[b.length - 1].live ? b.length - 2 : b.length - 1;
    s.last = last;
    const recentFrom = last - RECENT_DAYS * s.ppd + 1;
    events(s, opts.history === false ? recentFrom : WARMUP, last).forEach((e) => {
      const c = callout(s, e, last, live, px);
      hist.push(c);
      if (e.at >= recentFrom) all.push(c);
    });
    // Watch list: the newest line of each chain, if price is close to it.
    [[s.act[last + 1].up, true], [s.act[last + 1].dn, false]].forEach(([ln, up]) => {
      if (!ln) return;
      const v = val(ln, s.x0 + last + 1), d = Math.abs(live - v) / s.A[last];
      if (d > WATCH_ATR) return;
      const g = grade(s, ln, last + 1 > b.length - 1 ? b.length - 1 : last + 1, up);
      watch.push({ tf, grade: g.grade, passed: g.passed, checks: g.checks, taps: g.taps, days: g.days, angle: g.angle, lineTF: tfOfLine(ln, tf), key: ln.a.t + ":" + ln.b.t,
        line: { t0: ln.a.t, p0: ln.a.p, t1: ln.b.t, p1: ln.b.p, up },
        kind: up ? "rising line under lows" : "falling line over highs", lineNow: px(v), dist: r2(d, 1),
        plan: up ? tf + " close below " + px(v) + " = short break. Tag and hold = long bounce." : tf + " close above " + px(v) + " = long break. Tag and reject = short bounce." });
    });
  });

  // Only callouts whose line passes at least 3 of the 4 checklist rules. Of those, one per market: the newest.
  // Same time: 4-hour before 1-hour, A+ before B, break before bounce. (opts.all: every callout, for tests.)
  const rank = (x) => (x.tf === "4H" ? 0 : 4) + (x.grade === "A+" ? 0 : 2) + (x.setup === "bounce" ? 1 : 0);
  all.sort((p, q) => q.t - p.t || rank(p) - rank(q));
  const fit = all.filter((x) => x.passed >= MIN_PASSED);
  fit.forEach((x) => { if (fit.some((y) => y !== x && y.t === x.t && y.dir !== x.dir)) x.mixed = true; });
  const sigs = opts.all ? all : fit.slice(0, 1);
  if (!opts.all && fit.length > 1) sigs[0].replaced = fit.length - 1;
  const seen = new Set(), wl = [];
  watch.sort((p, q) => (p.tf === q.tf ? p.dist - q.dist : p.tf === "4H" ? -1 : 1)).forEach((w) => { if (!seen.has(w.key)) { seen.add(w.key); wl.push(w); } });

  // Chart data for each callout: the last KEEP candles of its chart, lines in that window's candle numbers.
  const chartFor = (x) => {
    const s = S[x.tf], b = s.bars, end = s.last + (b[b.length - 1].live ? 1 : 0), off = Math.max(0, end + 1 - KEEP), base = s.x0 + off;
    // t0/t1: the times of point A and point B, so the line can be redrawn on TradingView.
    const loc = (ln) => ln && { i0: ln.a.x - base, p0: ln.a.p, slope: ln.slope, i1: ln.b.x - base, p1: ln.b.p, t0: ln.a.t, t1: ln.b.t };
    const ch = s.chainsBefore(s.last + 1);
    // Only real trendlines: swing point to swing point, 6+ candles, not flat (the same rule as action lines).
    // The short pieces in between would draw as a bend, and they're never traded.
    const edges = (c, up) => c.slice(1).map((q, k) => [c[k], q])
      .filter(([a, q]) => a.piv && q.piv && q.x - a.x >= MIN_GAP && q.p !== a.p)
      .map(([a, q]) => ({ up, ...loc(lineOf(a, q)) })).filter((e) => e.i1 >= -KEEP);
    // Every real line in both chains, Monthly down to 1-hour, with where its ray sits now.
    // X = position in daily candles (the merged x divided by candles per day), for the zoomed-out daily chart.
    const xNow = s.x0 + s.last + 1, same = (ln, o) => !!o && ln.a.t === o.a.t && ln.b.t === o.b.t;
    const zoff = Math.max(0, daily.length - ZOOM);
    const info = (ln, up) => {
      const v = val(ln, xNow);
      return { up, tf: tfOfLine(ln, x.tf), t0: ln.a.t, p0: ln.a.p, t1: ln.b.t, p1: ln.b.p, now: px(v), pct: r2((100 * (v - live)) / live, 1),
        action: same(ln, x.action), safety: same(ln, x.safety), X0: ln.a.x / s.ppd - zoff, P0: ln.a.p, slopeX: ln.slope * s.ppd };
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
      line: loc(x.action), safety: loc(x.safety), tapIdx: x.tapX.map((t) => t - base).filter((t) => t >= 0),
      at: x.at - off, from: x.from == null ? null : x.from - off, closedAt: x.closedAt == null ? null : x.closedAt - off,
      chains: edges(ch.up, true).concat(edges(ch.dn, false)),
      lines, zoom: daily.slice(zoff).map((q) => [q.t, px(q.o), px(q.h), px(q.l), px(q.c)]),
      // Middle view: about 3 months of 4-hour candles. X of candle k = X0 + k * dX (same daily-candle units as the lines).
      mid: (() => {
        const s4 = S["4H"], b4 = s4.bars, f4 = Math.max(0, b4.findIndex((q) => q.t >= b4[b4.length - 1].t - 91 * DAY));
        return { bars: b4.slice(f4).map((q) => [q.t, px(q.o), px(q.h), px(q.l), px(q.c)]), X0: (s4.x0 + f4) / s4.ppd - zoff, dX: 1 / s4.ppd };
      })(),
    };
  };
  const clean = (x) => {
    const o = { ...x, chart: chartFor(x) };
    ["action", "safety", "tapX", "from", "entryRaw", "riskRaw"].forEach((k) => delete o[k]);
    return o;
  };
  const b4 = sets["4H"], l4 = b4[b4.length - 1].live ? b4.length - 2 : b4.length - 1, prev = b4[Math.max(0, l4 - 6)].c;
  return {
    sym, name: meta.shortName || meta.longName || sym, kind: isFuture ? "futures" : "stocks",
    pointValue: POINT_VALUE[sym] || null, price: px(live), chg: r2(((b4[l4].c - prev) / prev) * 100, 2), digits: tick,
    dailyBars: daily.length, signals: sigs.map(clean), watch: wl.slice(0, 4), record: opts.history === false ? null : record(hist),
  };
}

module.exports = { scan, fourHour, oneHour, hourly, atr, chain, active, setup, record };
