// Trade Finder - service worker: shows phone alerts (Web Push) even when the site is closed.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { title: "Trade Finder", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Trade Finder", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || undefined, data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if ("focus" in w) return w.focus();
    return self.clients.openWindow(url);
  }));
});
