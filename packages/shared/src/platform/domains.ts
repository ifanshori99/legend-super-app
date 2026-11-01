// Domains (PRD v1.7 §3 F4 "Domain", §6 A `tenant_domains`, TEN-02, TEN-08).
// Every brand gets a default subdomain under the platform domain and may add
// custom domains; TLS is automatic. The platform domain itself comes from
// configuration (env), never from code. Hostname -> tenant is how the server
// learns the tenant for a public request (core TENANT_CONTEXT_SOURCES
// "domain"), so a client parameter can never pick the tenant.

import {
  brandIdSchema,
  clientInputSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  z,
} from "../core/index.ts";
import type { BrandId, TenantId } from "../core/index.ts";
import { tenantDomainIdSchema } from "./ids.ts";
import type { TenantStatus } from "./org.ts";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes a Host header / user-entered domain: lowercase, no port, no
 * trailing dot. Returns null for anything that is not a public DNS name
 * (IP literals, single labels, `localhost`, `.local`, `.internal`, bad
 * labels, over 253 characters).
 */
export function normalizeHostname(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[")) return null; // IPv6 literal
  host = host.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(tld)) return null; // rejects IPv4
  if (["localhost", "local", "internal", "localdomain"].includes(tld))
    return null;
  return host;
}

export const hostnameSchema = z
  .string()
  .max(260)
  .transform((value, ctx) => {
    const host = normalizeHostname(value);
    if (host === null) {
      ctx.addIssue({ code: "custom", message: "Not a public DNS hostname" });
      return z.NEVER;
    }
    return host;
  });

export const domainKindSchema = z.enum(["platform_subdomain", "custom"]);
export const tlsStatusSchema = z.enum(["pending", "active", "failed"]);
export type TlsStatus = z.infer<typeof tlsStatusSchema>;

/** `tenant_domains` (global). `hostname` is unique across the platform. */
export const tenantDomainSchema = z.strictObject({
  id: tenantDomainIdSchema,
  tenantId: tenantIdSchema,
  brandId: brandIdSchema,
  hostname: hostnameSchema,
  kind: domainKindSchema,
  tlsStatus: tlsStatusSchema,
  /** Ownership check for custom domains (DNS record); null until verified.
   * Platform subdomains are verified when created. */
  verifiedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type TenantDomain = z.infer<typeof tenantDomainSchema>;

/** Body for adding a custom domain to a brand (tenant from context). */
export const addDomainInputSchema = clientInputSchema({
  brandId: brandIdSchema,
  hostname: hostnameSchema,
});

/** `<slug>.<platform domain>`; the platform domain is configuration. */
export function platformSubdomain(
  slug: string,
  platformDomain: string,
): string {
  const base = normalizeHostname(platformDomain);
  if (base === null) throw new TypeError("Invalid platform domain");
  if (!LABEL.test(slug)) throw new TypeError("Invalid slug for a subdomain");
  const host = normalizeHostname(`${slug}.${base}`);
  if (host === null) throw new TypeError("Subdomain is not a valid hostname");
  return host;
}

export type HostResolution =
  | { ok: true; tenantId: TenantId; brandId: BrandId; domain: TenantDomain }
  | {
      ok: false;
      reason:
        "invalid_host" | "unknown_host" | "unverified" | "tenant_inactive";
    };

/**
 * TEN-02 host lookup (pure; the API runs it against `tenant_domains` and
 * then mints the context with source "domain"). A domain serves only when
 * verified and its tenant is active; anything else fails closed.
 */
export function resolveHost(
  host: string,
  domains: readonly TenantDomain[],
  tenantStatusOf: (tenantId: TenantId) => TenantStatus | undefined,
): HostResolution {
  const hostname = normalizeHostname(host);
  if (hostname === null) return { ok: false, reason: "invalid_host" };
  const domain = domains.find((row) => row.hostname === hostname);
  if (!domain) return { ok: false, reason: "unknown_host" };
  if (domain.verifiedAt === null) return { ok: false, reason: "unverified" };
  if (tenantStatusOf(domain.tenantId) !== "active")
    return { ok: false, reason: "tenant_inactive" };
  return {
    ok: true,
    tenantId: domain.tenantId,
    brandId: domain.brandId,
    domain,
  };
}
