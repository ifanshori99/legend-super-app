/* global self, caches */
/* Push payloads contain public-facing text only; endpoint and keys stay server-side. */
/*
 * O3 (legend-wasr7.7, review O3 P2 2): app shell of /pos/kasir for the offline
 * POS. Only same-origin GETs are touched: API calls (another origin) and
 * server functions pass through. A /pos page is always fetched from the
 * network; only when that fails does the worker answer with the cached
 * /pos/kasir shell. The shell is fetched by the worker itself without
 * cookies (`credentials: "omit"`), so it never holds a session or another
 * page's data, and a `no-store` or redirected answer is not kept. Built assets
 * are content-hashed: served from the cache once fetched, at most ASSET_LIMIT.
 * Sign-out deletes the cache (window side, `caches.delete`).
 */
const POS_SHELL = "legend-pos-shell-v1";
const SHELL_PATH = "/pos/kasir";
const ASSET_LIMIT = 400;

const isPosPath = (path) => path === "/pos" || path.startsWith("/pos/");
const cacheable = (response) =>
  response.ok &&
  response.type === "basic" &&
  !response.redirected &&
  !/no-store/i.test(response.headers.get("cache-control") ?? "");

/** The session-free shell, fetched once while online. */
async function refreshShell(origin) {
  const cache = await caches.open(POS_SHELL);
  if (await cache.match(origin + SHELL_PATH)) return;
  try {
    const response = await fetch(origin + SHELL_PATH, {
      credentials: "omit",
      redirect: "manual",
    });
    if (cacheable(response)) await cache.put(origin + SHELL_PATH, response);
  } catch {
    // Offline or refused: tried again on the next /pos page.
  }
}

async function posPage(event, url) {
  try {
    const response = await fetch(event.request);
    event.waitUntil(refreshShell(url.origin));
    return response;
  } catch {
    const cache = await caches.open(POS_SHELL);
    return (await cache.match(url.origin + SHELL_PATH)) ?? Response.error();
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
    event.respondWith(posPage(event, url));
    return;
  }
  if (url.pathname.startsWith("/assets/")) event.respondWith(asset(request));
});
