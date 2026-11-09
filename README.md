# Trade Finder

Live 4-hour trendline break and bounce callouts for futures and stocks, using Tori Trades' trendline strategy.

- `index.html`: the page (callouts, watch list, rules, alerts)
- `api/trades.js`: Vercel function. Pulls hourly bars from Yahoo Finance and builds 4-hour candles. Cached 5 minutes.
- `api/_trendlines.js`: the scanner (her A+ checklist, action and safety lines, 2R targets)
- `server.js`: run it on your own computer with `node server.js` (Vercel doesn't use it)
- `tests/smoke.js`: run `node tests/smoke.js` before pushing. It must print "All checks passed". It uses saved prices, no live calls.

Deploy: import this repo into Vercel. There's nothing to configure: `vercel.json` sets no framework.

Not trading advice. A computer draws the lines, so check every callout on your own chart.
