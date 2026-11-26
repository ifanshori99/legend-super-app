import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { logger } from "@/lib/logger.server";
import {
  decidePublicCache,
  publicCacheSeconds,
} from "@/lib/public-cache.server";
import {
  isRequestDegraded,
  runWithRequestContext,
} from "@/lib/request-context.server";

const STATIC_ASSET =
  /\.(?:js|mjs|css|map|svg|png|jpe?g|gif|webp|ico|woff2?|txt)$/;

// Browser hardening for every page and server function response. Other sites
// cannot frame the app (CSP frame-ancestors, plus X-Frame-Options for older
// browsers). A script-src policy needs per-request nonces for Start's inline
// scripts, so add one deliberately when your app needs it. HSTS is sent only
// in production, so a local HTTPS setup never pins a development hostname.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  ...(process.env.NODE_ENV === "production"
    ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
    : {}),
};

const PUBLIC_HTML_CACHE_SECONDS = publicCacheSeconds(
  process.env.PUBLIC_HTML_CACHE_SECONDS,
);

// A route that sets one of these headers itself keeps its own value.
const securityHeaders = createMiddleware().server(async ({ request, next }) => {
  const result = await next();
  const headers = result.response.headers;
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    if (!headers.has(name)) headers.set(name, value);
  // Every SSR page embeds the visitor's session and access context, so no
  // shared cache (Cloudflare, a proxy) may store it: `private, no-store`.
  // The exception is the anonymous brand site (see public-cache.server.ts).
  // A route that sets its own Cache-Control keeps it (PRD §5 "Peta situs"
  // lists the dynamic, authorized and no-store pages).
  // O3: the /pos-offline shell may be kept only as the service worker
  // fetches it, without cookies; a visit with a cookie may embed a session.
  if (
    new URL(request.url).pathname === "/pos-offline" &&
    request.headers.has("cookie")
  )
    headers.set("Cache-Control", "private, no-store");
  if (!headers.has("Cache-Control")) {
    const decision = decidePublicCache({
      method: request.method,
      pathname: new URL(request.url).pathname,
      status: result.response.status,
      requestHeaders: request.headers,
      responseHeaders: headers,
      seconds: PUBLIC_HTML_CACHE_SECONDS,
    });
    headers.set("Cache-Control", decision.cacheControl);
    if (decision.vary !== null) headers.set("Vary", decision.vary);
    // One visitor's request ID must not be replayed to everyone by the cache.
    if (decision.cacheControl !== "private, no-store")
      headers.delete("X-Request-Id");
  }
  return result;
});

// Every request the web server handles (SSR pages, server routes, server
// functions) gets a request ID and one access-log line. The ID is forwarded to
// the API by the session lookup and apiFetch during SSR.
const requestLogger = createMiddleware().server(async ({ request, next }) => {
  const { pathname } = new URL(request.url);
  if (STATIC_ASSET.test(pathname) || pathname.startsWith("/@")) return next();
  return runWithRequestContext(
    request.headers.get("x-request-id"),
    async (reqId) => {
      const started = performance.now();
      try {
        const result = await next();
        const status = result.response.status;
        result.response.headers.set("X-Request-Id", reqId);
        // A render that fell back to defaults after a transient upstream
        // failure must never reach a shared cache (legend-vz93). securityHeaders
        // keeps a Cache-Control the route or this middleware already set.
        if (isRequestDegraded())
          result.response.headers.set("Cache-Control", "private, no-store");
        const line = `${request.method} ${pathname} ${status} ${Math.round(performance.now() - started)}ms`;
        if (status >= 500) logger.error(line);
        else if (status >= 400) logger.warn(line);
        else logger.info(line);
        return result;
      } catch (err) {
        // Redirects and not-found are thrown as control flow; let Start
        // handle them and only record real failures.
        if (err instanceof Error)
          logger.error(
            { err },
            `${request.method} ${pathname} failed after ${Math.round(performance.now() - started)}ms`,
          );
        throw err;
      }
    },
  );
});

export const startInstance = createStart(() => ({
  requestMiddleware: [
    // First, so it also covers responses the CSRF check refuses.
    securityHeaders,
    // A custom start.ts replaces Start's defaults, so CSRF protection for
    // server functions must be added back explicitly.
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    requestLogger,
  ],
}));
