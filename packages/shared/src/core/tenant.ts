// Tenant context and outlet scope.
// TEN-02: "tenant ditentukan dari domain atau token, bukan dari parameter
// klien". Enforced at three levels:
// 1. Type level: TenantContext carries a private brand, so an object literal
//    (e.g. built from req.query) is not assignable to it. Code that touches
//    tenant data takes a TenantContext parameter, and the only constructor is
//    establishTenantContext, called by server middleware after resolving the
//    tenant from the host name, session/device/MCP token, job or webhook.
// 2. Contract level: clientInputSchema refuses tenant fields when a request
//    schema is defined (TypeScript error + TypeError), and parses strictly, so a
//    submitted tenantId is rejected rather than silently dropped.
// 3. Database level: RLS + SET LOCAL app.tenant_id (bead legend-73d).
// TEN-03: outlet-scoped roles see only their assigned outlets (OutletScope).

import { z } from "zod";
import { brandIdSchema, outletIdSchema, tenantIdSchema } from "./ids";
import type { BrandId, OutletId, TenantId } from "./ids";

/** Where the server learned the tenant. Never a client-supplied parameter. */
export const TENANT_CONTEXT_SOURCES = [
  "domain", // host name -> tenant_domains (brand custom domain or tenant subdomain)
  "session", // signed-in session whose active tenant was fixed by the domain
  "device", // registered outlet device token (POS, KDS, edge)
  "mcp_token", // MCP OAuth token issued for one tenant
  "job", // background job payload written by the server (carries tenant_id)
  "webhook", // provider account / receiving WhatsApp number -> tenant
] as const;
export type TenantContextSource = (typeof TENANT_CONTEXT_SOURCES)[number];

declare const tenantContextBrand: unique symbol;

/** Server-resolved tenant. Construct only with establishTenantContext. */
export type TenantContext = {
  readonly tenantId: TenantId;
  /** Set when the domain or token pins one brand of the tenant. */
  readonly brandId: BrandId | null;
  readonly source: TenantContextSource;
  readonly [tenantContextBrand]: true;
};

const tenantContextInput = z.strictObject({
  tenantId: tenantIdSchema,
  brandId: brandIdSchema.nullable(),
  source: z.enum(TENANT_CONTEXT_SOURCES),
});

/**
 * Server-side only by convention: call it in the middleware that resolved the
 * tenant from a domain or token, never with values read from the request
 * body, query or a client header. Returns a frozen context.
 */
export function establishTenantContext(input: {
  tenantId: string;
  brandId: string | null;
  source: TenantContextSource;
}): TenantContext {
  return Object.freeze(tenantContextInput.parse(input)) as TenantContext;
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

/** Which outlets a role assignment may see (TEN-03). */
export const outletScopeSchema = z.discriminatedUnion("kind", [
  /** Every outlet of the tenant (owner, finance, HR head office roles). */
  z.strictObject({ kind: z.literal("tenant") }),
  /** Only the listed outlets (outlet-scoped roles such as cashier). */
  z.strictObject({
    kind: z.literal("outlets"),
    outletIds: z.array(outletIdSchema).min(1),
  }),
]);
export type OutletScope = z.infer<typeof outletScopeSchema>;

export function isOutletInScope(
  scope: OutletScope,
  outletId: OutletId,
): boolean {
  return scope.kind === "tenant" || scope.outletIds.includes(outletId);
}

/** Tenant context plus the caller's outlet scope; what services receive. */
export type ScopedTenantContext = TenantContext & {
  readonly outletScope: OutletScope;
};
