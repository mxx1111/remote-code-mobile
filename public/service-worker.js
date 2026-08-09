const CACHE_PREFIX = "remote-shell-mobile-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const APP_SHELL = [
  "/manifest.webmanifest",
  "/icons/apple-touch-icon.png",
  "/icons/favicon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];

async function installAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const pageResponse = await fetch("/");
  if (!pageResponse.ok) {
    throw new Error("Unable to cache the app shell");
  }
  const pageHtml = await pageResponse.clone().text();
  const assetUrls = [...pageHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((match) => match[1]);

  await cache.put("/", pageResponse);
  await cache.addAll([...APP_SHELL, ...assetUrls]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    installAppShell()
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function fetchAndCache(request, cacheKey = request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchAndCache(request, "/").catch(async () => {
        const cachedPage = await caches.match(request);
        return cachedPage ?? caches.match("/");
      }),
    );
    return;
  }

  if (
    url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/manifest.webmanifest"
  ) {
    event.respondWith(
      caches.match(request).then((cached) => cached ?? fetchAndCache(request)),
    );
  }
});
