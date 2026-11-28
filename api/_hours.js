// Trade Finder - market hours in New York time (not a Vercel function: the file name starts with _).
// Used to skip work while a market is closed (Vercel's free plan has 4 CPU hours a month).
function ny(ms = Date.now()) {
  const p = {};
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), mins = Number(p.hour) * 60 + Number(p.minute);
  return { wd, mins, day: p.year + "-" + p.month + "-" + p.day };
}
// Stocks: Mon-Fri 9:30 AM to 4:00 PM, plus 30 minutes after the close (the last 4-hour candle's callouts).
function stocksOpen(ms) { const t = ny(ms); return t.wd >= 1 && t.wd <= 5 && t.mins >= 570 && t.mins < 990; }
// Futures: Sunday 6 PM to Friday 5 PM, with a break from 5 to 6 PM each day.
function futuresOpen(ms) {
  const t = ny(ms);
  if (t.wd === 6 || (t.wd === 5 && t.mins >= 1020) || (t.wd === 0 && t.mins < 1080)) return false;
  return !(t.mins >= 1020 && t.mins < 1080);
}
// Which 4-hour stock candle has most recently closed today ("a" none yet, "b" the 9:30 one, "c" the 1:30 one).
function stockCandle(ms) { const t = ny(ms); return t.day + (t.mins < 810 ? "a" : t.mins < 960 ? "b" : "c"); }
// The weekend: from Friday's 5 PM futures close to Sunday's 6 PM open, both markets are shut. Nothing runs then.
function weekend(ms) { const t = ny(ms); return t.wd === 6 || (t.wd === 5 && t.mins >= 1020) || (t.wd === 0 && t.mins < 1080); }
// Seconds until a market next opens (checked in 15-minute steps, at most 3 days ahead): how long a result worked
// out while it's closed stays good, since nothing changes until then.
function secsToOpen(isOpen, ms = Date.now()) {
  for (let k = 0; k <= 72 * 4; k++) if (isOpen(ms + k * 900000)) return Math.max(600, k * 900);
  return 72 * 3600;
}
module.exports = { ny, stocksOpen, futuresOpen, stockCandle, weekend, secsToOpen };
