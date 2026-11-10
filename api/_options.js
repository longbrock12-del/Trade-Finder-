// Trade Finder - picks option contracts for a stock callout. Not a Vercel function (file name starts with _).
// Options are NOT part of Tori Trades' strategy (she trades futures). This is an add-on, and every number
// below is my choice for a 4-hour swing trade that can last days to a few weeks:
//   - Calls for long callouts, puts for short callouts.
//   - 21-75 days to expiry: room for the trade to work without fast time decay in the last 3 weeks.
//   - Delta 0.45-0.75 (at or a little in the money): moves with the stock, less decay than cheap far-out contracts.
//   - Tradable: open interest 100+, a real bid, and a bid-ask spread under 10% of the price.
// Each contract is priced at the callout's target and stop with a delta-gamma estimate (no time decay, so
// it assumes the move happens fairly soon), never below what the option is worth at expiry.

const MIN_DTE = 21, MAX_DTE = 75, MIN_DELTA = 0.45, MAX_DELTA = 0.75, MIN_OI = 100, MAX_SPREAD = 0.1;
const IDEAL_DELTA = 0.6, IDEAL_DTE = 45;
const DAY = 86400000;

function parse(code) {
  const m = /^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(code || "");
  if (!m) return null;
  return { root: m[1], exp: Date.UTC(2000 + Number(m[2]), Number(m[3]) - 1, Number(m[4]), 21), type: m[5], strike: Number(m[6]) / 1000 };
}

const r2 = (x) => Math.round(x * 100) / 100;

// q: { dir: "long"|"short", entry, stop, target (may be null: then 2R) }
function pick(chain, q, now = Date.now()) {
  const d = chain && chain.data;
  if (!d || !Array.isArray(d.options)) return { error: "no options data" };
  const S = Number(d.current_price), long = q.dir === "long", type = long ? "C" : "P";
  const risk = Math.abs(q.entry - q.stop);
  if (!(S > 0) || !(risk > 0)) return { error: "bad prices" };
  const target = q.target != null ? q.target : long ? q.entry + 2 * risk : q.entry - 2 * risk;
  const intrinsic = (o, px) => Math.max(0, type === "C" ? px - o.strike : o.strike - px);
  const value = (o, mid, px) => { const dx = px - S; return Math.max(intrinsic(o, px), mid + o.delta * dx + 0.5 * o.gamma * dx * dx); };

  const rows = [];
  let seen = 0;
  d.options.forEach((raw) => {
    const p = parse(raw.option);
    if (!p || p.type !== type) return;
    const dte = Math.round((p.exp - now) / DAY);
    if (dte < MIN_DTE || dte > MAX_DTE) return;
    seen++;
    const bid = Number(raw.bid), ask = Number(raw.ask), delta = Number(raw.delta), gamma = Number(raw.gamma) || 0;
    if (!(bid > 0) || !(ask > bid)) return;
    const mid = (bid + ask) / 2, spread = (ask - bid) / mid, ad = Math.abs(delta);
    if (ad < MIN_DELTA || ad > MAX_DELTA || spread > MAX_SPREAD || Number(raw.open_interest) < MIN_OI) return;
    const o = { ...p, delta, gamma };
    const atT = value(o, mid, target), atS = Math.max(0, value(o, mid, q.stop));
    const gain = atT - mid, loss = mid - atS;
    if (!(gain > 0) || !(loss > 0)) return;
    const payoff = gain / loss;
    const score = payoff - 3 * Math.abs(ad - IDEAL_DELTA) - 4 * spread - Math.abs(dte - IDEAL_DTE) / 60 + Math.log10(Number(raw.open_interest)) / 10;
    rows.push({
      contract: raw.option, type: type === "C" ? "call" : "put", strike: p.strike, expiry: new Date(p.exp).toISOString().slice(0, 10), dte,
      bid: r2(bid), ask: r2(ask), mid: r2(mid), cost: Math.round(mid * 100), delta: r2(delta), iv: Math.round(Number(raw.iv) * 1000) / 10,
      oi: Number(raw.open_interest), volume: Number(raw.volume) || 0, theta: r2(Number(raw.theta) || 0), spreadPct: Math.round(spread * 1000) / 10,
      breakeven: r2(type === "C" ? p.strike + mid : p.strike - mid),
      atTarget: r2(atT), atTargetPct: Math.round((gain / mid) * 100), atStop: r2(atS), atStopPct: -Math.round((loss / mid) * 100), payoff: r2(payoff), score,
    });
  });
  rows.sort((a, b) => b.score - a.score);
  // Top 3, but not three strikes of the same expiry: at most 2 per expiry.
  const out = [], per = {};
  for (const r of rows) {
    if ((per[r.expiry] || 0) >= 2) continue;
    per[r.expiry] = (per[r.expiry] || 0) + 1;
    out.push(r);
    if (out.length === 3) break;
  }
  out.forEach((r) => { delete r.score; });
  return {
    sym: d.symbol, price: r2(S), target: r2(target), stop: r2(q.stop), targetIsDefault: q.target == null, contracts: out,
    note: out.length ? null : seen ? "No contract passed the filters (21-75 days, delta 0.45-0.75, open interest 100+, spread under 10%)." : "No options expiring in 21-75 days.",
  };
}

module.exports = { pick, parse };
