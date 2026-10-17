/* =========================================================
   Cosplay Archive — Service Worker (PWA & Offline Shell)
   ========================================================= */

const CACHE_NAME = "cosplay-archive-v29";

const PRECACHE_ASSETS = [
  "./",
  "index.html",
  "manifest.json",
  "css/style.css",
  "js/config.js",
  "js/providers/registry.js",
  "js/drive.js",
  "js/providers/dropbox.js",
  "js/vendor/jszip.min.js",
  "js/vendor/zip-full.min.js",
  "js/app.js",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

// Установка: кэшируем оболочку приложения
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_ASSETS).catch(err => {
        console.warn("ServiceWorker precache error:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Активация: очищаем старые версии кэша
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Перехват сетевых запросов
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  // Только GET-запросы
  if (request.method !== "GET") return;

  // Внешние API (Google Drive, Dropbox, Google Fonts, GIS) — не кэшируем, только сеть
  if (
    url.hostname.includes("googleapis.com") ||
    url.hostname.includes("google.com") ||
    url.hostname.includes("dropboxapi.com") ||
    url.hostname.includes("dropbox.com")
  ) {
    return;
  }

  // Навигация (переход на страницу / открытие сайта) — Network First, fallback to cached index.html
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put("index.html", clone));
          }
          return response;
        })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // Статические локальные ресурсы (CSS, JS, иконки) — Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(cached => {
        const fetchPromise = fetch(request)
          .then(networkResponse => {
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
            }
            return networkResponse;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});
