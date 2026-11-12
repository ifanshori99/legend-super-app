import type { Request } from "express";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";

type ResolvedTenant = { tenantId: string; brandId: string | null };
type Options = {
  enabled: boolean;
  hostname: string | undefined;
  resolveDomain(hostname: string): Promise<ResolvedTenant | null>;
};

const PUBLIC_READ_PATHS = new Set([
  "/api/tenant/context",
  "/api/public/site",
  "/api/public/site/menu",
]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Inspect the raw header, not req.hostname: the API does not necessarily trust
// the web server as a proxy. In particular an unknown web Host arrives here as
// X-Forwarded-Host while the upstream connection's Host is still localhost.
function isLoopbackHost(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(
    value,
  );
  return (
    match !== null &&
    (match[1] === undefined ||
      (Number(match[1]) >= 1 && Number(match[1]) <= 65535))
  );
}

/**
 * Public website preview for an explicitly configured synthetic local domain.
 * This supplies tenant context only: the synthetic "session" source grants no
 * authentication and keeps the published site's canonical URL and no-store
 * policy. Every private route retains its normal tenant/session checks.
 */
export async function developmentPublicSiteCredential(
  req: Request,
  options: Options,
): Promise<(ResolvedTenant & { source: "session" }) | null> {
  if (
    !options.enabled ||
    !options.hostname ||
    req.method !== "GET" ||
    !PUBLIC_READ_PATHS.has(req.originalUrl.split("?")[0] ?? "") ||
    !LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "") ||
    !isLoopbackHost(req.headers.host) ||
    (req.headers["x-forwarded-host"] !== undefined &&
      !isLoopbackHost(req.headers["x-forwarded-host"])) ||
    req.headers.authorization !== undefined ||
    req.headers[DEVICE_TOKEN_HEADER] !== undefined
  )
    return null;

  // Use the ordinary verified-domain + active-tenant lookup. Missing or
  // suspended seed data fails closed instead of choosing another tenant.
  const tenant = await options.resolveDomain(options.hostname);
  return tenant ? { ...tenant, source: "session" } : null;
}
