/* global self, caches */
/* Push payloads contain public-facing text only; endpoint and keys stay server-side. */
/*
 * O3 (legend-wasr7.7, review O3 P2 2, re-review P1): offline shell of the POS.
 * Only same-origin GETs are touched: API calls (another origin) and server
 * functions pass through. A /pos page is always fetched from the network;
 * only when that fails does the worker send the tablet to /pos-offline, a
 * public route outside the `_ops` guard that loads no data. The worker fetches
 * that shell itself without cookies (`credentials: "omit"`), so the cached
 * copy never holds a session; a `no-store`, redirected or failed answer is
 * not kept. The built assets the shell names are fetched with it. Assets are
 * content-hashed: served from the cache once fetched, at most ASSET_LIMIT.
 * Sign-out deletes the cache (window side, `caches.delete`).
 *
 * O5 follow-up (Keputusan CTO 27 Nov, 6 a): the build lists every chunk of the
 * /pos routes in /pos-precache.json. The worker keeps them at install and on
 * each shell refresh (a new deploy lists new hashed names, and this file does
 * not change, so install does not run again), so a client navigation on the
 * offline tablet finds its code. The list holds public build files only.
 */
const POS_SHELL = "legend-pos-shell-v2";
const SHELL_PATH = "/pos-offline";
const SHELL_REFRESH_MS = 10 * 60 * 1000;
const PRECACHE_PATH = "/pos-precache.json";
const ASSET_LIMIT = 1200;

const isPosPath = (path) => path === "/pos" || path.startsWith("/pos/");
const cacheable = (response) =>
  response.ok &&
  response.type === "basic" &&
  !response.redirected &&
  !/no-store/i.test(response.headers.get("cache-control") ?? "");

let shellFetchedAt = 0;
// Review K O5 P3 2: the assets of the deploy now live (the shell's and the
// precache list), so trimming drops other deploys' leftovers first.
const liveShell = new Set();
const livePos = new Set();

/** The session-free shell and its assets, refreshed while online. */
async function refreshShell(origin) {
  if (Date.now() - shellFetchedAt < SHELL_REFRESH_MS) return;
  shellFetchedAt = Date.now();
  try {
    const response = await fetch(origin + SHELL_PATH, {
      credentials: "omit",
      redirect: "manual",
    });
    if (!cacheable(response)) return;
    const html = await response.clone().text();
    const cache = await caches.open(POS_SHELL);
    const assets = new Set(html.match(/\/assets\/[^"'\s)<>]+/g) ?? []);
    liveShell.clear();
    for (const path of assets) liveShell.add(path);
    for (const path of assets)
      if (!(await cache.match(origin + path))) {
        const asset = await fetch(origin + path, { credentials: "omit" });
        if (cacheable(asset)) await cache.put(origin + path, asset);
      }
    await cache.put(origin + SHELL_PATH, response);
    await trimAssets(cache);
    await precachePos(origin);
  } catch {
    // Offline or refused: tried again on a later /pos page.
    shellFetchedAt = 0;
  }
}

async function posPage(event, url) {
  try {
    const response = await fetch(event.request);
    event.waitUntil(refreshShell(url.origin));
    return response;
  } catch {
    const cache = await caches.open(POS_SHELL);
    return (await cache.match(url.origin + SHELL_PATH))
      ? Response.redirect(url.origin + SHELL_PATH, 302)
      : Response.error();
  }
}

/** The shell itself: the network (still without cookies), else the kept copy. */
async function shellPage(url) {
  try {
    return await fetch(url.origin + SHELL_PATH, { credentials: "omit" });
  } catch {
    const cache = await caches.open(POS_SHELL);
    return (await cache.match(url.origin + SHELL_PATH)) ?? Response.error();
  }
}

async function trimAssets(cache) {
  const keys = (await cache.keys()).filter((request) =>
    new URL(request.url).pathname.startsWith("/assets/"),
  );
  const excess = keys.length - ASSET_LIMIT;
  if (excess <= 0) return;
  const live = (request) => {
    const path = new URL(request.url).pathname;
    return liveShell.has(path) || livePos.has(path);
  };
  const order = [
    ...keys.filter((request) => !live(request)),
    ...keys.filter(live),
  ];
  for (const request of order.slice(0, excess)) await cache.delete(request);
}

/** Keeps the /pos route chunks the build lists; best-effort, skips kept ones. */
async function precachePos(origin) {
  try {
    // Review K O5 P3 3: always revalidated, a stale list would miss new chunks.
    const response = await fetch(origin + PRECACHE_PATH, {
      credentials: "omit",
      cache: "no-cache",
    });
    if (!response.ok) return;
    const list = await response.json();
    if (!Array.isArray(list)) return;
    const cache = await caches.open(POS_SHELL);
    livePos.clear();
    for (const path of list)
      if (typeof path === "string" && path.startsWith("/assets/"))
        livePos.add(path);
    for (const path of list) {
      if (typeof path !== "string" || !path.startsWith("/assets/")) continue;
      if (await cache.match(origin + path)) continue;
      const asset = await fetch(origin + path, { credentials: "omit" });
      if (cacheable(asset)) await cache.put(origin + path, asset);
    }
    await trimAssets(cache);
  } catch {
    // Offline or refused: tried again on a later shell refresh.
  }
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

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(precachePos(self.location.origin));
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
  if (request.mode === "navigate" && url.pathname === SHELL_PATH) {
    event.respondWith(shellPage(url));
    return;
  }
  if (url.pathname.startsWith("/assets/")) event.respondWith(asset(request));
});

// Sign-out deleted the cache: the next /pos page fetches the shell again.
self.addEventListener("message", (event) => {
  if (event.data?.type === "legend-pos-shell-reset") shellFetchedAt = 0;
});
