// Trade Finder - scanner for Tori Trades' trendline strategy (4-hour chart, no indicators).
// Sources for the rules: her FX Replay checklist ("Tori Trades Trend Line Strategy (swing trading)") and the
// TradeZella playbook ("Tori's Trendline Strategy"). Not a Vercel function (file name starts with _).
//
// What it does, on 4-hour candles built from Yahoo hourly bars:
//   1. Finds trendlines drawn through wicks: falling lines across swing highs, rising lines across swing lows.
//   2. Grades each line with her A+ checklist: 3+ taps, 6+ candles between taps, under 45 degrees with
//      3 months on the chart, 3+ weeks from first tap to the break. 2-tap or 1-3 week lines are grade B.
//   3. Break setup: a 4H candle CLOSES through the line (the action line). The stop sits on the opposing
//      trendline (the safety line), fixed where that line will be 4 candles after the break.
//      Target: the nearest earlier swing high/low that pays at least 2R.
//   4. Bounce setup: price tags a rising (or falling) line and closes back on the right side. The same line is
//      the stop, with room for wicks.
// Numbers that are my reading of loose wording (not stated by her) are marked "my number" below.

const HOUR = 3600, DAY = 86400;
const PIVOT = 3;          // a swing high/low is the extreme of 3 candles each side
const SAFE_PIVOT = 2;     // safety lines use recent swings, so 2 candles each side
const MIN_GAP = 6;        // her rule: 6+ candles between taps
const MAX_ANGLE = 45;     // her rule: under 45 degrees with 3 months on the chart
const ASPECT = 1.8;       // my number: chart width / height of a normal screen, used to turn slope into degrees
const TOUCH_ATR = 0.3;    // my number: a wick within 0.3 ATR of the line counts as a tap
const POKE_ATR = 0.5;     // my number: a wick may stab past the line by this much before the line is ruined
const FAR_ATR = 3;        // my number: "break must be close to the safety line" - skip if risk is over 3 ATR
const BOUNCE_ROOM = 0.5;  // my number: bounce stop sits 0.5 ATR past the line ("give it room for wicks")
const RECENT = { futures: 30, stocks: 10 }; // breaks from the last ~5 trading days are listed (6 futures / 2 stock candles a day)
// Dollars per 1.00 move for one contract, so callouts can show risk and reward per contract.
const POINT_VALUE = { "MGC=F": 10, "MCL=F": 100, "GC=F": 100, "CL=F": 1000 };

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
function et(ts) {
  const p = {};
  fmt.formatToParts(new Date(ts * 1000)).forEach((x) => { p[x.type] = x.value; });
  return { day: p.year + "-" + p.month + "-" + p.day, h: Number(p.hour) % 24, m: Number(p.minute), wd: p.weekday };
}

// Yahoo chart JSON -> hourly bars [{t,o,h,l,c}]
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
  return out.map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, live: !!x.live }));
}

function atr(b, n = 14) {
  const tr = b.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l));
  const out = [];
  let s = 0;
  tr.forEach((v, i) => { s += v; if (i >= n) s -= tr[i - n]; out.push(s / Math.min(i + 1, n)); });
  return out;
}

function pivots(b, key, k, upto) {
  const hi = key === "h", out = [];
  for (let i = k; i <= upto - k; i++) {
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j++) {
      if (j === i) continue;
      if (hi ? b[j].h > b[i].h : b[j].l < b[i].l) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

// Slope (price per candle) -> degrees on a chart showing the last 3 months.
function angleOf(slope, b, last) {
  const from = b[last].t - 91 * DAY;
  let n = 0, hi = -Infinity, lo = Infinity;
  for (let i = last; i >= 0 && b[i].t >= from; i--) { n++; hi = Math.max(hi, b[i].h); lo = Math.min(lo, b[i].l); }
  const range = hi - lo || 1;
  return (Math.atan((Math.abs(slope) * n) / range / ASPECT) * 180) / Math.PI;
}

const at = (ln, i) => ln.p0 + ln.slope * (i - ln.i0);

// Every trendline through two swing points that price respected, with its taps and where it broke.
// side "res": falling line over highs (a close above = long break). side "sup": rising line under lows.
function lines(b, side, last, A) {
  const res = side === "res", key = res ? "h" : "l";
  const piv = pivots(b, key, PIVOT, last);
  const found = [];
  for (let x = 0; x < piv.length; x++) {
    for (let y = x + 1; y < piv.length; y++) {
      const i0 = piv[x], i1 = piv[y];
      if (i1 - i0 < MIN_GAP) continue;
      const slope = (b[i1][key] - b[i0][key]) / (i1 - i0);
      if (res ? slope >= 0 : slope <= 0) continue;
      const ln = { i0, p0: b[i0][key], slope };
      let brk = -1, bad = false;
      for (let i = i0; i <= last; i++) {
        const v = at(ln, i), c = b[i].c;
        if (res ? c > v : c < v) {
          if (i <= i1) { bad = true; break; }
          brk = i; break;
        }
        if (res ? b[i].h > v + POKE_ATR * A[i] : b[i].l < v - POKE_ATR * A[i]) { bad = true; break; }
      }
      if (bad) continue;
      const end = brk < 0 ? last : brk - 1;
      const taps = [];
      for (let i = i0; i <= end; i++) {
        const v = at(ln, i), w = b[i][key];
        if (Math.abs(w - v) > TOUCH_ATR * A[i]) continue;
        const lo = Math.max(0, i - 2), hi2 = Math.min(end, i + 2);
        let ext = true;
        for (let j = lo; j <= hi2; j++) if (res ? b[j].h > w : b[j].l < w) ext = false;
        if (!ext) continue;
        if (taps.length && i - taps[taps.length - 1] < MIN_GAP) continue;
        taps.push(i);
      }
      if (taps.length < 2) continue;
      const days = (b[brk < 0 ? last : brk].t - b[taps[0]].t) / DAY;
      found.push({ side, i0, p0: ln.p0, slope, taps, brk, days, angle: angleOf(slope, b, last) });
    }
  }
  // Keep the line that catches the most taps; drop near-copies sharing two taps with a better one.
  found.sort((p, q) => q.taps.length - p.taps.length || (q.taps[q.taps.length - 1] - q.taps[0]) - (p.taps[p.taps.length - 1] - p.taps[0]));
  const kept = [];
  found.forEach((f) => {
    if (kept.some((k) => k.taps.filter((t) => f.taps.includes(t)).length >= 2)) return;
    kept.push(f);
  });
  return kept;
}

function grade(ln) {
  const checks = {
    taps: ln.taps.length >= 3,
    spacing: true, // enforced while counting taps (6+ candles apart)
    angle: ln.angle < MAX_ANGLE,
    history: ln.days >= 21,
  };
  if (!checks.angle || ln.days < 7) return null; // too steep, or under the 1-week minimum: not a setup
  return { grade: checks.taps && checks.history ? "A+" : "B", checks };
}

// Safety line for a break: the opposing trendline through the two latest swings before the break.
// Long: a rising line under two higher lows. Short: a falling line over two lower highs.
function safety(b, long, brk) {
  const key = long ? "l" : "h";
  const piv = pivots(b, key, SAFE_PIVOT, brk).filter((i) => i <= brk);
  for (let y = piv.length - 1; y >= 1; y--) {
    for (let x = y - 1; x >= 0; x--) {
      const i0 = piv[x], i1 = piv[y];
      if (i1 - i0 < 3) continue;
      const slope = (b[i1][key] - b[i0][key]) / (i1 - i0);
      if (long ? slope <= 0 : slope >= 0) continue;
      const ln = { i0, p0: b[i0][key], slope };
      let ok = true;
      for (let i = i0; i <= brk && ok; i++) if (long ? b[i].c < at(ln, i) : b[i].c > at(ln, i)) ok = false;
      if (ok) return ln;
    }
    if (brk - piv[y] > 40) break; // only look at recent structure
  }
  return null;
}

// Nearest earlier swing level (a place price reacted) that pays at least 2R.
function target(b, long, entry, risk, upto) {
  const lv = pivots(b, long ? "h" : "l", PIVOT, upto).map((i) => (long ? b[i].h : b[i].l));
  const need = long ? entry + 2 * risk : entry - 2 * risk;
  const ok = lv.filter((p) => (long ? p >= need : p <= need));
  if (!ok.length) return null;
  return long ? Math.min(...ok) : Math.max(...ok);
}

// Walk forward from entry with a fixed stop and target (her mechanical backtest version).
// Includes the candle still forming: a stop or target touched there has already happened.
function follow(b, long, from, last, stop, tgt) {
  for (let i = from + 1; i <= last; i++) {
    const hitS = long ? b[i].l <= stop : b[i].h >= stop, hitT = tgt != null && (long ? b[i].h >= tgt : b[i].l <= tgt);
    if (hitS) return { status: "stopped", at: i };   // same candle hits both: count the loss
    if (hitT) return { status: "target", at: i };
  }
  return { status: "open" };
}

const r2 = (x, a) => (x == null ? null : Number(x.toFixed(a)));

function scan(chart, opts = {}) {
  const now = opts.now || Date.now() / 1000;
  const { meta, bars: hb } = hourly(chart);
  const isFuture = (meta.instrumentType || "").toUpperCase() === "FUTURE" || /=F$/.test(opts.sym || meta.symbol || "");
  const b = fourHour(hb, isFuture, now);
  if (b.length < 60) return { sym: meta.symbol, error: "not enough price history" };
  const last = b[b.length - 1].live ? b.length - 2 : b.length - 1;
  const A = atr(b);
  const tick = b[last].c >= 1000 ? 1 : b[last].c >= 50 ? 2 : b[last].c >= 1 ? 3 : 5;
  const px = (x) => r2(x, tick);
  const signals = [], watch = [], live = hb[hb.length - 1].c; // latest price, from the newest hourly bar

  ["res", "sup"].forEach((side) => {
    lines(b, side, last, A).forEach((ln) => {
      const g = grade(ln);
      if (!g) return;
      const res = side === "res";
      const base = { grade: g.grade, checks: g.checks, taps: ln.taps.length, days: Math.round(ln.days), angle: Math.round(ln.angle), line: { i0: ln.i0, p0: ln.p0, slope: ln.slope }, tapIdx: ln.taps };

      if (ln.brk >= 0) {
        if (ln.brk < last - RECENT[isFuture ? "futures" : "stocks"]) return;
        const long = res, brk = ln.brk;
        const sig = { ...base, setup: ln.taps.length >= 3 ? "3-touch break" : "2-touch break", dir: long ? "long" : "short", at: brk, t: b[brk].t, entry: px(b[brk].c) };
        let s = safety(b, long, brk), from = brk, late = false;
        if (!s) {
          // Her rule: no safety line at the break -> wait for a clear swing, then enter if price is still past the line.
          const s2 = safety(b, long, last), still = long ? b[last].c > at(ln, last) : b[last].c < at(ln, last);
          if (!s2 || !still || last === brk) { signals.push({ ...sig, status: "no-safety", note: "No safety line yet. Wait for a clear swing " + (long ? "low" : "high") + " to form, then draw one." }); return; }
          s = s2; from = last; late = true; sig.entry = px(b[last].c);
        }
        const entry = b[from].c, stop = at(s, from + 4), risk = long ? entry - stop : stop - entry;
        if (!(risk > 0)) { signals.push({ ...sig, status: "no-safety", note: "Safety line is on the wrong side of entry." }); return; }
        const tgt = target(b, long, entry, risk, from);
        const out = follow(b, long, from, b.length - 1, stop, tgt);
        const far = risk > FAR_ATR * A[from];
        signals.push({ ...sig, safety: s, stop: px(stop), target: px(tgt), risk: px(risk), rr: tgt == null ? null : r2(Math.abs(tgt - entry) / risk, 1),
          status: far ? "too-far" : out.status, closedAt: out.at, nowR: r2(((long ? 1 : -1) * (live - entry)) / risk, 2),
          late, note: far ? "Break closed too far from the safety line (risk over " + FAR_ATR + " ATR). Her rule: skip it." : late ? "Safety line formed after the break. Entry is the latest close." : tgt == null ? "No earlier level pays 2R. Trail the stop on the safety line instead." : null });
        return;
      }

      // Unbroken line: bounce now, or on the watch list if price is close. (If a later 4H candle closes through
      // the line, it counts as broken: the bounce drops off and a break callout the other way replaces it -
      // her rule that a close through the line ends a bounce trade.)
      const v = at(ln, last), d = Math.abs(b[last].c - v) / A[last];
      // Bounce needs 2+ earlier taps (TradeZella: "two or three clear touchpoints before entry").
      const touched = [last, last - 1].find((i) => ln.taps.filter((t) => t < i - 2).length >= 2 && Math.abs(b[i][res ? "h" : "l"] - at(ln, i)) <= TOUCH_ATR * A[i] && (res ? b[i].c < at(ln, i) : b[i].c > at(ln, i)));
      if (touched != null) {
        const long = !res, entry = b[touched].c, stop = at(ln, touched + 1) + (long ? -1 : 1) * BOUNCE_ROOM * A[touched];
        const risk = long ? entry - stop : stop - entry;
        if (risk > 0) {
          const tgt = target(b, long, entry, risk, touched);
          const out = follow(b, long, touched, b.length - 1, stop, tgt);
          signals.push({ ...base, setup: "bounce", dir: long ? "long" : "short", at: touched, t: b[touched].t, entry: px(entry), stop: px(stop), target: px(tgt), risk: px(risk),
            rr: tgt == null ? null : r2(Math.abs(tgt - entry) / risk, 1), status: out.status, closedAt: out.at, nowR: r2(((long ? 1 : -1) * (live - entry)) / risk, 2),
            note: "Exit if a 4H candle closes " + (long ? "below" : "above") + " the line. Trail the stop along it." });
          return;
        }
      }
      if (d <= 1.5) watch.push({ ...base, kind: res ? "falling line over highs" : "rising line under lows", lineNow: px(v), dist: r2(d, 1),
        plan: res ? "Close above " + px(v) + " = long break. Tag and reject = short bounce." : "Close below " + px(v) + " = short break. Tag and hold = long bounce." });
    });
  });

  // Several lines often break on the same candle: keep the best one (A+ first, then most taps).
  const best = {};
  signals.sort((p, q) => (p.grade === q.grade ? q.taps - p.taps : p.grade === "A+" ? -1 : 1)).forEach((x) => {
    const k = (x.setup === "bounce" ? "b" : "k") + x.dir + x.at;
    if (best[k]) best[k].also = (best[k].also || 0) + 1; else best[k] = x;
  });
  const sigs = Object.values(best).sort((p, q) => q.at - p.at || (p.grade === "A+" ? -1 : 1));
  // Opposite callouts on the same candle (broke one line, rejected at another): flag both.
  sigs.forEach((x) => { if (sigs.some((y) => y !== x && y.at === x.at && y.dir !== x.dir)) x.mixed = true; });
  // A live callout with a newer one the other way on the same market: flag it, so you know price turned.
  sigs.forEach((x) => { if (x.status === "open" && sigs.some((y) => y.at > x.at && y.dir !== x.dir && y.status !== "no-safety")) x.flipped = true; });
  const wbest = {};
  watch.forEach((w) => { const k = w.kind + w.lineNow; if (!wbest[k] || wbest[k].taps < w.taps) wbest[k] = w; });
  watch.length = 0; watch.push(...Object.values(wbest));
  watch.sort((p, q) => (p.grade === q.grade ? p.dist - q.dist : p.grade === "A+" ? -1 : 1));
  // Send enough candles that every tap on every listed line is on the chart (at least 240).
  const firstTap = Math.min(b.length - 240, ...sigs.concat(watch.slice(0, 4)).map((x) => x.tapIdx[0] - 6));
  const off = Math.max(0, firstTap);
  const shift = (o) => {
    const c = { ...o, at: o.at - off, line: { ...o.line, i0: o.line.i0 - off }, tapIdx: o.tapIdx.map((i) => i - off) };
    if (o.closedAt != null) c.closedAt = o.closedAt - off;
    if (o.safety) c.safety = { ...o.safety, i0: o.safety.i0 - off };
    return c;
  };
  const prev = b[Math.max(0, last - 6)].c;
  return {
    sym: opts.sym || meta.symbol, name: meta.shortName || meta.longName || meta.symbol, kind: isFuture ? "futures" : "stocks",
    pointValue: POINT_VALUE[opts.sym || meta.symbol] || null,
    price: px(hb[hb.length - 1].c), chg: r2(((b[last].c - prev) / prev) * 100, 2), atr: px(A[last]),
    barTime: b[last].t, lastIdx: last - off, digits: tick,
    bars: b.slice(off).map((x) => [x.t, px(x.o), px(x.h), px(x.l), px(x.c)]),
    signals: sigs.map(shift), watch: watch.slice(0, 4).map(shift),
  };
}

module.exports = { scan, fourHour, hourly, pivots, atr, lines, grade };
