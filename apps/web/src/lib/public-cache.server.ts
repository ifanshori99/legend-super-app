// CDN cacheability of the brand website's public HTML (legend-vz93). Pure so
// it is testable without a server; src/start.ts applies the decision.

const NO_STORE = "private, no-store";
const DEFAULT_SECONDS = 60;
const STALE_WHILE_REVALIDATE_SECONDS = 300;

// Only the brand home and the online menu. Every other page can carry the
// visitor's session or access context, so it stays private.
const CACHEABLE_PATHS = new Set(["/", "/menu"]);

// PUBLIC_HTML_CACHE_SECONDS: shared-cache lifetime in seconds. Unset or
// invalid means the default; 0 turns public caching off.
export function publicCacheSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SECONDS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_SECONDS;
}

export type PublicCacheInput = {
  method: string;
  pathname: string;
  status: number;
  requestHeaders: Headers;
  /** What the route already set: cache-control, set-cookie, vary. */
  responseHeaders: Headers;
  seconds: number;
};

export type PublicCacheDecision = {
  cacheControl: string;
  /** The full Vary value to send; null leaves the response's Vary as is. */
  vary: string | null;
};

function mergeVary(existing: string | null): string {
  const tokens = (existing ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  // Vary: * already forbids sharing; do not weaken it.
  if (tokens.includes("*")) return tokens.join(", ");
  if (!tokens.some((token) => token.toLowerCase() === "host"))
    tokens.push("Host");
  return tokens.join(", ");
}

// Cacheable only when anonymous (no Cookie header at all), a read-only 200 for
// an allowlisted path, with no Set-Cookie. A route that set its own
// Cache-Control keeps it. The cache key must include Host, so each tenant
// domain gets its own entry.
export function decidePublicCache(
  input: PublicCacheInput,
): PublicCacheDecision {
  const { method, pathname, status, requestHeaders, responseHeaders } = input;
  const own = responseHeaders.get("cache-control");
  if (own !== null && own.trim().toLowerCase() !== NO_STORE)
    return { cacheControl: own, vary: null };
  const cacheable =
    input.seconds > 0 &&
    (method === "GET" || method === "HEAD") &&
    CACHEABLE_PATHS.has(pathname) &&
    status === 200 &&
    !requestHeaders.has("cookie") &&
    !responseHeaders.has("set-cookie");
  if (!cacheable) return { cacheControl: NO_STORE, vary: null };
  return {
    cacheControl: `public, max-age=0, s-maxage=${input.seconds}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
    vary: mergeVary(responseHeaders.get("vary")),
  };
}
