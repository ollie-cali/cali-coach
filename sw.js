// Cali Coach service worker: cache the app shell (same-origin), network-first.
const CACHE = "cali-coach-v29";
const SHELL = ["./", "./index.html", "./app.js", "./engine.js", "./scorer.js", "./manifest.json", "./calihome.html", "./calilink.js", "./mirror.html"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); });
self.addEventListener("fetch", e => {
  if (new URL(e.request.url).origin !== location.origin) return;   // CDN/model: browser cache handles it
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request)));
});
