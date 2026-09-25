const CACHE_NAME = "zuara-ghp-v20260925-4";
const BASE = new URL("./", self.location.href).pathname;
const APP_SHELL = [
  BASE,
  BASE + "index.html",
  BASE + "static/style.css?v=20260925-3",
  BASE + "static/main.js?v=20260925-4",
  BASE + "static/neon-config.js",
  BASE + "static/neon-api.js",
  BASE + "static/manifest.webmanifest?v=20260925-3",
  BASE + "static/zuara-logo.svg?v=20260925-3"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API/database traffic must always reach the backend.
  if (url.pathname.startsWith(BASE + "api/") || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(BASE, copy));
          return response;
        })
        .catch(() => caches.match(BASE))
    );
    return;
  }

  // Same-origin assets: cache first, network fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request)
        .then((cached) => cached || fetch(request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        }))
    );
  }
});