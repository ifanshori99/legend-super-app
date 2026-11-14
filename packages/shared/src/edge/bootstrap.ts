// Edge bootstrap bundle (bead legend-khu5; PRD v1.7 §3 F5 "Server Lokal",
// TEN-02). A fresh edge node has an empty local database, but its own
// edge_nodes row (and every link table) needs the tenant and outlet rows as
// foreign keys. At boot the edge fetches this bundle from the cloud with its
// credential and inserts the rows it names, FK order:
// tenant -> legal entity -> brand -> outlet.
//
// The bundle carries exactly the columns needed to insert those rows and
// nothing else: one tenant, the outlet the credential is bound to, and the
// legal entity and brand that outlet references. No secrets: the NPWP
// (sealed value, blind index and last four, which the database stores as a
// pair) is left out, and the outlet's `region_id` is not sent (regions are a
// global table the edge does not carry; the edge stores null).
//
// `signature` is HMAC-SHA256 (hex) over `canonicalJson(bundle)`, keyed with
// the node's credential digest (32 bytes, the hex `credential_hash` the cloud
// stores, which the edge derives from its own credential). The edge verifies
// it over the bundle exactly as received, before any parsing.
//
// What the signature does NOT prove: the key is the credential digest,
// which the cloud database stores and which anyone holding (or able to
// tamper with a response for) the bearer token can derive. So it only catches
// corruption and misrouting (a bundle meant for another node). Authenticity
// comes from TLS: EDGE_CLOUD_URL must be wss:// (fetched over https://)
// outside development. Do not reuse this pattern for cloud->edge commands;
// real authenticity there needs an Ed25519 cloud signing key pinned on the
// edge.
//
// JSONB columns (feature flags, limits, geofence, opening hours) travel as
// the plain JSON objects the cloud row holds: the bundle copies rows, so it
// must not refuse a row the cloud database accepted.

import {
  brandIdSchema,
  businessDayCutoffSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  timeZoneSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { legalEntityIdSchema } from "../platform/ids.ts";
import {
  deploymentModeSchema,
  outletStatusSchema,
  slugSchema,
  tenantStatusSchema,
} from "../platform/org.ts";

export const EDGE_BOOTSTRAP_PATH = "/api/edge-sync/bootstrap";
export const EDGE_BOOTSTRAP_VERSION = 1;

const name150 = z.string().min(1).max(150);
/** A JSONB object column copied as stored. */
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** `tenants` row as inserted on the edge. */
export const edgeBootstrapTenantSchema = z.object({
  id: tenantIdSchema,
  slug: slugSchema,
  name: name150,
  plan: z.string().min(1).max(30),
  status: tenantStatusSchema,
  deploymentMode: deploymentModeSchema,
  featureFlags: jsonObjectSchema,
  limits: jsonObjectSchema,
  createdBy: z.string().min(1).max(255),
  createdAt: isoDateTimeSchema,
});
export type EdgeBootstrapTenant = z.infer<typeof edgeBootstrapTenantSchema>;

/** `legal_entities` row without the NPWP columns (stored null on the edge). */
export const edgeBootstrapLegalEntitySchema = z.object({
  id: legalEntityIdSchema,
  tenantId: tenantIdSchema,
  name: name150,
  isPkp: z.boolean(),
  address: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type EdgeBootstrapLegalEntity = z.infer<
  typeof edgeBootstrapLegalEntitySchema
>;

/** `brands` row as inserted on the edge. */
export const edgeBootstrapBrandSchema = z.object({
  id: brandIdSchema,
  tenantId: tenantIdSchema,
  slug: slugSchema,
  name: name150,
  logoMediaId: uuidSchema.nullable(),
  themeId: uuidSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type EdgeBootstrapBrand = z.infer<typeof edgeBootstrapBrandSchema>;

/** `outlets` row without `region_id` (stored null on the edge). */
export const edgeBootstrapOutletSchema = z.object({
  id: outletIdSchema,
  tenantId: tenantIdSchema,
  brandId: brandIdSchema,
  legalEntityId: legalEntityIdSchema,
  code: z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/),
  name: name150,
  address: z.string().min(1),
  geofence: jsonObjectSchema.nullable(),
  timezone: timeZoneSchema,
  businessDayCutoff: businessDayCutoffSchema,
  openingHours: jsonObjectSchema,
  edgeNodeId: uuidSchema.nullable(),
  status: outletStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type EdgeBootstrapOutlet = z.infer<typeof edgeBootstrapOutletSchema>;

/** FK-complete: every row is the tenant's, the outlet's parents are present. */
export const edgeBootstrapBundleSchema = z
  .object({
    version: z.literal(EDGE_BOOTSTRAP_VERSION),
    issuedAt: isoDateTimeSchema,
    tenant: edgeBootstrapTenantSchema,
    legalEntity: edgeBootstrapLegalEntitySchema,
    /** The brand(s) the outlet references (today exactly one). */
    brands: z.array(edgeBootstrapBrandSchema).min(1).max(1),
    outlet: edgeBootstrapOutletSchema,
  })
  .superRefine((bundle, ctx) => {
    const tenantId = bundle.tenant.id;
    if (
      bundle.legalEntity.tenantId !== tenantId ||
      bundle.outlet.tenantId !== tenantId ||
      bundle.brands.some((brand) => brand.tenantId !== tenantId)
    )
      ctx.addIssue({
        code: "custom",
        path: ["tenant"],
        message: "Every row must belong to the bundle's tenant",
      });
    if (bundle.outlet.legalEntityId !== bundle.legalEntity.id)
      ctx.addIssue({
        code: "custom",
        path: ["outlet", "legalEntityId"],
        message: "The outlet's legal entity is not in the bundle",
      });
    if (!bundle.brands.some((brand) => brand.id === bundle.outlet.brandId))
      ctx.addIssue({
        code: "custom",
        path: ["outlet", "brandId"],
        message: "The outlet's brand is not in the bundle",
      });
  });
/** Strict cloud output validation prevents accidentally sending extra columns. */
export const edgeBootstrapBundleCloudSchema = edgeBootstrapBundleSchema
  .safeExtend({
    tenant: edgeBootstrapTenantSchema.strict(),
    legalEntity: edgeBootstrapLegalEntitySchema.strict(),
    brands: z.array(edgeBootstrapBrandSchema.strict()).min(1).max(1),
    outlet: edgeBootstrapOutletSchema.strict(),
  })
  .strict();

export type EdgeBootstrapBundle = z.infer<typeof edgeBootstrapBundleSchema>;

export const edgeBootstrapResponseSchema = z.object({
  bundle: edgeBootstrapBundleSchema,
  /** HMAC-SHA256 (lowercase hex) over canonicalJson(bundle). */
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EdgeBootstrapResponse = z.infer<typeof edgeBootstrapResponseSchema>;

/**
 * Edge node only: `Authorization: Bearer <edge credential>`. Tenant and
 * outlet come from the verified credential. `Cache-Control: private,
 * no-store`.
 */
export const getEdgeBootstrap = defineEndpoint({
  method: "GET",
  path: EDGE_BOOTSTRAP_PATH,
  response: edgeBootstrapResponseSchema,
});

/**
 * Canonical JSON: object keys sorted (code point order) at every depth, no
 * whitespace, array order kept, `undefined` members dropped (as
 * JSON.stringify does). Both sides sign/verify these exact bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .flatMap((key) => {
      const member = (value as Record<string, unknown>)[key];
      return member === undefined
        ? []
        : [`${JSON.stringify(key)}:${canonicalJson(member)}`];
    });
  return `{${entries.join(",")}}`;
}
