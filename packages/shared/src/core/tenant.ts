// Tenant context and outlet scope: browser-safe types and checks.
// TEN-02: "tenant ditentukan dari domain atau token, bukan dari parameter
// klien". Enforced at four levels:
// 1. Runtime provenance: a TenantContext / OutletScope is valid only if the
//    server entry (`@starter/shared/core/server`) minted it. Service
//    boundaries call assertTrustedTenantContext / assertTrustedScopedContext;
//    plain objects, JSON round-trips and copies are rejected (trust.ts).
// 2. Type level: both types carry a private brand, so an object literal is not
//    assignable to them.
// 3. Contract level: clientInputSchema refuses tenant fields when a request
//    schema is defined (TypeScript error + TypeError) and parses strictly, so a
//    submitted tenantId is rejected rather than silently dropped.
// 4. Database level: RLS + SET LOCAL app.tenant_id (bead legend-73d).
// TEN-03: outlet-scoped roles see only their assigned outlets, including in
// reports, exports, Tanya AI and MCP (isOutletInScope, outletIdsForQuery),
// backed by the `outlet_isolation` RLS policy on outlet-owned tables
// (SET LOCAL app.outlet_ids, bead legend-tjey; contracts.md D-CORE-3).

import { z } from "zod";
import { CoreError } from "./errors.ts";
import { brandIdSchema, outletIdSchema, tenantIdSchema } from "./ids.ts";
import type { BrandId, OutletId, TenantId } from "./ids.ts";
import {
  hasOutletScopeProvenance,
  hasTenantContextProvenance,
} from "./trust.ts";

/** Where the server learned the tenant. Never a client-supplied parameter. */
export const TENANT_CONTEXT_SOURCES = [
  "domain", // host name -> tenant_domains (brand custom domain or tenant subdomain)
  "session", // signed-in session whose active tenant was fixed by the domain
  "device", // registered outlet device token (POS, KDS, edge)
  "mcp_token", // MCP OAuth token issued for one tenant
  "job", // background job payload written by the server (carries tenant_id)
  "webhook", // provider account / receiving WhatsApp number -> tenant
  "link_token", // signed guest link token (payment link, e-receipt) -> tenant
] as const;
export type TenantContextSource = (typeof TENANT_CONTEXT_SOURCES)[number];

declare const tenantContextBrand: unique symbol;
declare const outletScopeBrand: unique symbol;

/** Server-resolved tenant. Minted only by `@starter/shared/core/server`. */
export type TenantContext = {
  readonly tenantId: TenantId;
  /** Set when the domain or token pins one brand of the tenant. */
  readonly brandId: BrandId | null;
  readonly source: TenantContextSource;
  readonly [tenantContextBrand]: true;
};

export const tenantContextDataSchema = z.strictObject({
  tenantId: tenantIdSchema,
  brandId: brandIdSchema.nullable(),
  source: z.enum(TENANT_CONTEXT_SOURCES),
});

/**
 * Wire/data shape of a role assignment's outlet reach. Data only: it grants
 * nothing until the server mints an OutletScope from verified assignments.
 */
export const outletScopeDataSchema = z.discriminatedUnion("kind", [
  /** Every outlet of the tenant (owner, finance, head-office roles). */
  z.strictObject({ kind: z.literal("tenant") }),
  /** Only the listed outlets (outlet-scoped roles such as cashier). */
  z.strictObject({
    kind: z.literal("outlets"),
    outletIds: z.array(outletIdSchema).min(1),
  }),
]);
export type OutletScopeData = z.infer<typeof outletScopeDataSchema>;

/** Server-minted outlet reach, bound to one tenant. */
export type OutletScope = OutletScopeData & {
  readonly tenantId: TenantId;
  readonly [outletScopeBrand]: true;
};

/** Tenant context plus the caller's outlet scope; what services receive. */
export type ScopedTenantContext = {
  readonly tenant: TenantContext;
  readonly outletScope: OutletScope;
};

export function isTrustedTenantContext(value: unknown): value is TenantContext {
  return hasTenantContextProvenance(value);
}

/** Service boundary check: throws unless the server minted this context. */
export function assertTrustedTenantContext(
  value: unknown,
): asserts value is TenantContext {
  if (!hasTenantContextProvenance(value))
    throw new TypeError(
      "Untrusted tenant context: resolve the tenant from the domain or token on the server (TEN-02)",
    );
}

export function isTrustedOutletScope(value: unknown): value is OutletScope {
  return hasOutletScopeProvenance(value);
}

export function assertTrustedOutletScope(
  value: unknown,
): asserts value is OutletScope {
  if (!hasOutletScopeProvenance(value))
    throw new TypeError(
      "Untrusted outlet scope: derive it on the server from verified role assignments (TEN-03)",
    );
}

/** Both parts minted by the server and bound to the same tenant. */
export function assertTrustedScopedContext(
  value: unknown,
): asserts value is ScopedTenantContext {
  const candidate = value as Partial<ScopedTenantContext> | null;
  assertTrustedTenantContext(candidate?.tenant);
  assertTrustedOutletScope(candidate?.outletScope);
  if (candidate.outletScope.tenantId !== candidate.tenant.tenantId)
    throw new TypeError("Outlet scope belongs to a different tenant");
}

/** Keys a client request may never carry (TEN-02). */
export const CLIENT_FORBIDDEN_KEYS = ["tenantId", "tenant_id"] as const;
type ClientForbiddenKey = (typeof CLIENT_FORBIDDEN_KEYS)[number];

type WithoutTenantKeys<Shape> = {
  [Key in keyof Shape]: Key extends ClientForbiddenKey ? never : Shape[Key];
};

/**
 * Strict object schema for a client request body or query. Defining one with
 * a tenantId / tenant_id field is a type error and throws at module load;
 * parsing input that contains one fails because the object is strict.
 */
export function clientInputSchema<Shape extends z.ZodRawShape>(
  shape: Shape & WithoutTenantKeys<Shape>,
) {
  for (const key of CLIENT_FORBIDDEN_KEYS)
    if (Object.hasOwn(shape, key))
      throw new TypeError(
        `Client input must not carry "${key}"; the tenant comes from the domain or token (TEN-02)`,
      );
  return z.strictObject(shape as Shape);
}

/**
 * True if the outlet is inside a server-minted scope. Throws TypeError for an
 * untrusted scope (fail closed). Ids compare case-insensitively.
 */
export function isOutletInScope(
  scope: OutletScope,
  outletId: OutletId | string,
): boolean {
  assertTrustedOutletScope(scope);
  if (scope.kind === "tenant") return true;
  const wanted = outletId.toLowerCase();
  return scope.outletIds.some((id) => id.toLowerCase() === wanted);
}

/** Throws CoreError OUTLET_OUT_OF_SCOPE when the outlet is outside the scope. */
export function assertOutletInScope(
  scope: OutletScope,
  outletId: OutletId | string,
): void {
  if (!isOutletInScope(scope, outletId))
    throw new CoreError(
      "OUTLET_OUT_OF_SCOPE",
      "Anda tidak memiliki akses ke outlet ini.",
    );
}

/** Outlet filter for a list, report, export, Tanya AI or MCP query. */
export type OutletQueryFilter =
  | { readonly kind: "all" }
  | { readonly kind: "outlets"; readonly outletIds: readonly OutletId[] };

/**
 * Turns the outlets a caller asked for into the filter a query must apply.
 * - Nothing requested: the whole scope (all outlets, or the assigned ones).
 * - Outlets requested: each must be in scope, else OUTLET_OUT_OF_SCOPE; the
 *   result is the deduplicated, lowercased request.
 */
export function outletIdsForQuery(
  scope: OutletScope,
  requested?: readonly string[],
): OutletQueryFilter {
  assertTrustedOutletScope(scope);
  if (requested === undefined || requested.length === 0)
    return scope.kind === "tenant"
      ? { kind: "all" }
      : { kind: "outlets", outletIds: [...scope.outletIds] };
  const outletIds = [
    ...new Set(requested.map((id) => outletIdSchema.parse(id))),
  ];
  for (const outletId of outletIds) assertOutletInScope(scope, outletId);
  return { kind: "outlets", outletIds };
}
