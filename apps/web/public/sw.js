/* global self */
/* Push payloads contain public-facing text only; endpoint and keys stay server-side. */
/*
 * O3 (legend-wasr7.7): app shell of /pos for the offline POS. Only same-origin
 * GETs are touched: API calls (another origin) and server functions pass
 * through. A /pos page is network first (a fresh page whenever online) and
 * falls back to the last /pos page this tablet loaded; built assets are
 * content-hashed, so they are served from the cache once fetched. Sign-out
 * clears the shell (message `legend-pos-shell-clear`).
 */
const POS_SHELL = "legend-pos-shell-v1";
const POS_FALLBACK = "/pos/kasir";
const ASSET_LIMIT = 400;

const isPosPath = (path) => path === "/pos" || path.startsWith("/pos/");
const cacheable = (response) =>
  response.ok && response.type === "basic" && !response.redirected;

async function posPage(request, url) {
  const cache = await caches.open(POS_SHELL);
  const key = url.origin + url.pathname;
  try {
    const response = await fetch(request);
    if (cacheable(response)) await cache.put(key, response.clone());
    return response;
  } catch {
    return (
      (await cache.match(key)) ??
      (await cache.match(url.origin + POS_FALLBACK)) ??
      Response.error()
    );
  }
}

async function trimAssets(cache) {
  const keys = (await cache.keys()).filter((request) =>
    new URL(request.url).pathname.startsWith("/assets/"),
  );
  for (const request of keys.slice(0, Math.max(0, keys.length - ASSET_LIMIT)))
    await cache.delete(request);
}

async function asset(request) {
  const cache = await caches.open(POS_SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (cacheable(response)) {
    await cache.put(request, response.clone());
    await trimAssets(cache);
  }
  return response;
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("legend-pos-shell-") && name !== POS_SHELL)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && isPosPath(url.pathname)) {
    event.respondWith(posPage(request, url));
    return;
  }
  if (url.pathname.startsWith("/assets/")) event.respondWith(asset(request));
});

self.addEventListener("message", (event) => {
  if (event.origin && event.origin !== self.location.origin) return;
  if (event.data?.type === "legend-pos-shell-clear")
    event.waitUntil(caches.delete(POS_SHELL));
});

function notificationTarget(value) {
  if (typeof value !== "string" || !/^\/(?!\/)[^\s\\]*$/.test(value))
    return "/";
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? value : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  if (
    !message ||
    typeof message.title !== "string" ||
    !message.title.trim() ||
    typeof message.body !== "string" ||
    typeof message.tag !== "string" ||
    !message.tag
  )
    return;
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: message.body,
      tag: message.tag,
      renotify: false,
      data: { url: notificationTarget(message.data?.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target = new URL(
        notificationTarget(event.notification.data?.url),
        self.location.origin,
      ).href;
      const existing = windows.find((client) => client.url === target);
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    })(),
  );
});
