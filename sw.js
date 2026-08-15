// Bump this version string every time game.js / index.html / any core
// file changes — it's the ONLY thing that makes the browser notice the
// service worker itself changed and go through install → activate again.
// Previously this stayed "V4" across multiple code updates, so browsers
// that had already installed the old service worker kept serving the
// OLD cached game.js forever (cache-first, no expiry) even after the
// files on the server were replaced — which is why earlier bug fixes to
// game.js didn't seem to take effect.
const CACHE_NAME = "Don't Look Back V10";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./game.js",
  "./firebase-config.js",
  "./leaderboard.js",
  "./models/corridor/scene.gltf",
  "./models/corridor/scene.bin",
  "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js",
  "https://cdn.jsdelivr.net/npm/three@0.128/examples/js/loaders/GLTFLoader.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app's own code/markup (index.html, game.js, etc.)
// so a fresh deploy is picked up the next time the player has a network
// connection, instead of silently serving a stale cached copy forever.
// Falls back to cache only when the network request fails (offline).
// Large one-off binary assets (map models/textures) are NOT in ASSETS
// above and aren't rewritten often, so those stay cache-first via the
// second handler below — no need to re-download 100+MB every visit.
const APP_SHELL = new Set(ASSETS.filter((u) => u.startsWith("./")));
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isAppShell = event.request.mode === "navigate" ||
    APP_SHELL.has("./" + url.pathname.split("/").pop()) ||
    url.pathname.endsWith("/game.js") || url.pathname.endsWith("/index.html");

  if (isAppShell) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (map models, textures, third-party libs): cache-first,
  // same as before — these are big and effectively static once shipped.
  //
  // IMPORTANT: only a successful (response.ok) fetch gets cached. Without
  // this check, a single failed load (404, e.g. because a new model file
  // hadn't been deployed yet, or a browser hiccup) gets stored in the
  // cache and then served forever afterward — cache-first never
  // re-fetches once *something* is cached, even an error. This is why a
  // model added/fixed on the server can still show as permanently broken
  // for a returning player: their browser cached the old failure and
  // never asks the network again for that exact URL. Bumping CACHE_NAME
  // above clears everyone's old cache once (including any bad cached
  // responses), and this .ok check stops it from happening again for any
  // future asset.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
