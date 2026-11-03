import { getRequestHeader } from "@tanstack/react-start/server";
import { API_URL } from "@/lib/env";
import { logger } from "@/lib/logger.server";
import { getRequestContext } from "@/lib/request-context.server";

// Where the web server reaches the API during SSR. In Docker or a private
// network that can differ from the public origin the browser uses.
export function apiBaseUrl() {
  return process.env.API_INTERNAL_URL
    ? new URL(process.env.API_INTERNAL_URL).origin
    : API_URL;
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
  return headers;
}

export function logUpstreamFailure(
  path: string,
  detail: { status?: number; err?: unknown },
) {
  const fields = { upstream: path, status: detail.status, err: detail.err };
  if (detail.status === undefined || detail.status >= 500)
    logger.error(fields, `API request failed during SSR: ${path}`);
  else
    logger.debug(fields, `API answered ${detail.status} during SSR: ${path}`);
}
