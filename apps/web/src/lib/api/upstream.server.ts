import { isIP } from "node:net";
import { getRequestHeader } from "@tanstack/react-start/server";
import { API_URL } from "@/lib/env";
import { logger } from "@/lib/logger.server";
import {
  getRequestContext,
  markRequestDegraded,
} from "@/lib/request-context.server";

// Where the web server reaches the API during SSR. In Docker or a private
// network that can differ from the public origin the browser uses.
export function apiBaseUrl() {
  return process.env.API_INTERNAL_URL
    ? new URL(process.env.API_INTERNAL_URL).origin
    : API_URL;
}

// The visitor address from X-Forwarded-For, counting from the right: with N
// trusted proxy hops in front of this server (WEB_TRUST_PROXY_HOPS, default 2:
// Cloudflare + Caddy, same as the API's TRUST_PROXY=2) the entry N from the end is the one our own proxy chain
// appended; anything the client wrote sits further left and is never used.
// Returns null (header omitted) when the list is shorter or the entry is no IP.
export function visitorIpFromForwardedFor(
  forwardedFor: string | undefined,
  hops: number,
): string | null {
  if (!forwardedFor || !Number.isInteger(hops) || hops < 1) return null;
  const entries = forwardedFor.split(",").map((entry) => entry.trim());
  const candidate = entries[entries.length - hops];
  return candidate && isIP(candidate) !== 0 ? candidate : null;
}

function trustProxyHops(): number {
  const raw = process.env.WEB_TRUST_PROXY_HOPS;
  if (!raw) return 2;
  const hops = Number(raw);
  return Number.isInteger(hops) && hops >= 1 ? hops : 2;
}

// Headers for a server-to-API call made on behalf of the current visitor: their
// session cookie, public host, and request ID. The API must trust only its
// internal SSR proxy hop when honoring X-Forwarded-Host (TEN-02).
export function forwardedHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  // Use the Host received from the reverse proxy, never a client-provided
  // X-Forwarded-Host. The proxy must preserve the validated public Host.
  const host = getRequestHeader("host");
  if (host) headers["x-forwarded-host"] = host;
  const cookie = getRequestHeader("cookie");
  if (cookie) headers.cookie = cookie;
  const reqId = getRequestContext()?.reqId;
  if (reqId) headers["x-request-id"] = reqId;
  // The visitor address, proven to the API by the shared secret so the API can
  // charge its per-IP rate limit to the visitor, not to this server (moe5).
  // Both are omitted when the secret is unset: the API then ignores the IP.
  const secret = process.env.SSR_SHARED_SECRET;
  if (secret) {
    const visitorIp = visitorIpFromForwardedFor(
      getRequestHeader("x-forwarded-for"),
      trustProxyHops(),
    );
    if (visitorIp) {
      headers["x-starter-visitor-ip"] = visitorIp;
      headers["x-starter-ssr-auth"] = secret;
    }
  }
  return headers;
}

export function logUpstreamFailure(
  path: string,
  detail: { status?: number; err?: unknown },
) {
  const fields = { upstream: path, status: detail.status, err: detail.err };
  // A transient failure may leave the page on defaults: keep it out of shared
  // caches (legend-vz93). A plain 4xx is a real answer, not a degraded render.
  if (
    detail.status === undefined ||
    detail.status === 429 ||
    detail.status >= 500
  )
    markRequestDegraded();
  if (detail.status === undefined || detail.status >= 500)
    logger.error(fields, `API request failed during SSR: ${path}`);
  else
    logger.debug(fields, `API answered ${detail.status} during SSR: ${path}`);
}
