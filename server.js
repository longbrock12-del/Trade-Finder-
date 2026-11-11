// Trade Finder - local server. Needs Node.js 18+, nothing to install.
// Run:  node server.js   then open http://localhost:3000. Vercel doesn't use this file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const trades = require("./api/trades.js");
const options = require("./api/options.js");
const scanStocks = require("./api/scan.js");
const news = require("./api/news.js");

const PORT = Number(process.env.PORT) || 3000;
// Home-screen app files.
const ASSETS = {
  "/manifest.json": "application/manifest+json",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/apple-touch-icon.png": "image/png",
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }
  const asset = ASSETS[pathname];
  if (asset) {
    res.writeHead(200, { "Content-Type": asset, "Cache-Control": "public, max-age=3600" });
    return fs.createReadStream(path.join(__dirname, pathname.slice(1))).pipe(res);
  }
  if (pathname === "/api/trades") return trades(req, res);
  if (pathname === "/api/options") return options(req, res);
  if (pathname === "/api/scan") return scanStocks(req, res);
  if (pathname === "/api/news") return news(req, res);
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => console.log("Trade Finder is running at http://localhost:" + PORT));
