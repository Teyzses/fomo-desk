// Service worker: the app shell opens offline (network first, cache fallback). The encrypted data files
// (d/...) are never cached here: the app keeps its own last good numbers. Push: STEP 10 plan B is Telegram only.
const V = "desk-shell-v14";
const SHELL = ["./", "index.html", "app.css", "app.js", "chart.js", "manifest.json", "icons/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.includes("/d/")) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(V).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
self.addEventListener("push", (e) => {
  const d = e.data ? e.data.json() : { title: "Grok Bot", body: "" };
  e.waitUntil(self.registration.showNotification(d.title || "Grok Bot", { body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: d.url || "./" } }));
});
self.addEventListener("notificationclick", (e) => { e.notification.close(); e.waitUntil(clients.openWindow(e.notification.data.url)); });
