// Offline-capable service worker for the PWA.
// Strategy: network-first (so a new deploy is always picked up when online),
// with the cache used only as an offline fallback. This avoids users getting
// stuck on a stale cached version after an update.
const CACHE = "mini-football-v28";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./game.js",
  "./scene.js",
  "./net.js",
  "./vendor/three.min.js",
  "./vendor/peerjs.min.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Network-first: try the network, fall back to cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && (res.type === "basic" || res.type === "default")) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
