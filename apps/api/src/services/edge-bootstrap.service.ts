// Edge bootstrap bundle, cloud side (bead legend-khu5; PRD v1.7 §3 F5
// "Server Lokal", TEN-02). The edge node asks for the rows its empty local
// database needs before its own edge_nodes row can exist: its tenant, its
// outlet, and the legal entity and brand that outlet references. Contract and
// column choice: packages/shared/src/edge/bootstrap.ts.
//
// - Tenant and outlet come from the verified edge credential only; every
//   query filters on them, inside the node's outlet-scoped tenant context.
// - Fail closed like the device-registry pull: inactive tenant, closed or
//   unknown outlet, or a node that is not active on that outlet -> FORBIDDEN.
// - No secrets: NPWP columns are never selected. The signature key is the
//   digest of the credential the node actually presented (already verified
//   by the route). During a rotation grace period that is the previous
//   credential, which is the one the edge holds and verifies with; the
//   stored current hash would make its check fail.
// - What the signature does NOT prove: the key is the credential digest,
//   which the cloud database stores and which anyone holding (or able to
//   tamper with a response for) the bearer token can derive. So it only catches
//   corruption and misrouting (a bundle meant for another node). Authenticity
//   comes from TLS: EDGE_CLOUD_URL must be wss:// (fetched over https://)
//   outside development. Do not reuse this pattern for cloud->edge commands;
//   real authenticity there needs an Ed25519 cloud signing key pinned on the
//   edge.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CoreError } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  canonicalJson,
  EDGE_BOOTSTRAP_VERSION,
  edgeBootstrapBundleCloudSchema,
  type EdgeBootstrapBundle,
  type EdgeBootstrapResponse,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import {
  brands,
  legalEntities,
  outlets,
  tenants,
} from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import {
  verifiedEdgeNodeSchema,
  type VerifiedEdgeNode,
} from "./staff-pin-sync.ts";

/** HMAC-SHA256 (hex) of canonicalJson(bundle), keyed with the 32-byte digest. */
export function signEdgeBootstrapBundle(
  bundle: unknown,
  credentialHash: string,
): string {
  const key = Buffer.from(credentialHash, "hex");
  if (key.length !== 32) throw new Error("Invalid edge credential digest");
  return createHmac("sha256", key).update(canonicalJson(bundle)).digest("hex");
}

/** Constant-time check of a received signature; false for any bad shape. */
export function edgeBootstrapSignatureMatches(
  bundle: unknown,
  signature: unknown,
  credentialHash: string,
): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature))
    return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(
      signEdgeBootstrapBundle(bundle, credentialHash),
      "hex",
    );
  } catch {
    return false;
  }
  const received = Buffer.from(signature, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

const denied = () =>
  new CoreError(
    "FORBIDDEN",
    "Edge node tidak dapat mengambil data awal outlet ini.",
  );

/**
 * The signed bundle for one verified edge node. `presentedCredential` is the
 * bearer token that `verifyEdgeCredential` accepted for `node`.
 */
export async function buildEdgeBootstrapBundle(
  node: VerifiedEdgeNode,
  presentedCredential: string,
  options: { now?: Date } = {},
): Promise<EdgeBootstrapResponse> {
  const verified = verifiedEdgeNodeSchema.parse(node);
  const { tenantId, outletId, edgeNodeId } = verified;
  const presented = parseEdgeCredential(presentedCredential);
  if (
    !presented ||
    presented.tenantId.toLowerCase() !== tenantId.toLowerCase() ||
    presented.outletId.toLowerCase() !== outletId.toLowerCase() ||
    presented.edgeNodeId.toLowerCase() !== edgeNodeId.toLowerCase()
  )
    throw denied();
  const context = outletContext(
    establishTenantContext({ tenantId, brandId: null, source: "device" }),
    outletId,
  );

  const bundle = await withTenant(db, context, async (tx) => {
    const [tenant] = await tx
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        plan: tenants.plan,
        status: tenants.status,
        deploymentMode: tenants.deploymentMode,
        featureFlags: tenants.featureFlags,
        limits: tenants.limits,
        createdBy: tenants.createdBy,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [outlet] = await tx
      .select({
        id: outlets.id,
        tenantId: outlets.tenantId,
        brandId: outlets.brandId,
        legalEntityId: outlets.legalEntityId,
        code: outlets.code,
        name: outlets.name,
        address: outlets.address,
        geofence: outlets.geofence,
        timezone: outlets.timezone,
        businessDayCutoff: outlets.businessDayCutoff,
        openingHours: outlets.openingHours,
        edgeNodeId: outlets.edgeNodeId,
        status: outlets.status,
        createdAt: outlets.createdAt,
      })
      .from(outlets)
      .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
      .limit(1);
    if (tenant?.status !== "active" || !outlet || outlet.status === "closed")
      throw denied();
    const [edgeNode] = await tx
      .select({ id: edgeNodes.id })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, tenantId),
          eq(edgeNodes.outletId, outletId),
          eq(edgeNodes.id, edgeNodeId),
          eq(edgeNodes.status, "active"),
        ),
      )
      .limit(1);
    if (!edgeNode) throw denied();
    const [legalEntity] = await tx
      .select({
        id: legalEntities.id,
        tenantId: legalEntities.tenantId,
        name: legalEntities.name,
        isPkp: legalEntities.isPkp,
        address: legalEntities.address,
        createdAt: legalEntities.createdAt,
      })
      .from(legalEntities)
      .where(
        and(
          eq(legalEntities.tenantId, tenantId),
          eq(legalEntities.id, outlet.legalEntityId),
        ),
      )
      .limit(1);
    const brandRows = await tx
      .select({
        id: brands.id,
        tenantId: brands.tenantId,
        slug: brands.slug,
        name: brands.name,
        logoMediaId: brands.logoMediaId,
        themeId: brands.themeId,
        createdAt: brands.createdAt,
      })
      .from(brands)
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, outlet.brandId)))
      .limit(1);
    // The composite FKs make both present; a missing one is corrupt data.
    if (!legalEntity || brandRows.length === 0)
      throw new Error("Outlet parent rows are missing");
    const draft: EdgeBootstrapBundle = edgeBootstrapBundleCloudSchema.parse({
      version: EDGE_BOOTSTRAP_VERSION,
      issuedAt: (options.now ?? new Date()).toISOString(),
      tenant: { ...tenant, createdAt: tenant.createdAt.toISOString() },
      legalEntity: {
        ...legalEntity,
        createdAt: legalEntity.createdAt.toISOString(),
      },
      brands: brandRows.map((brand) => ({
        ...brand,
        createdAt: brand.createdAt.toISOString(),
      })),
      outlet: { ...outlet, createdAt: outlet.createdAt.toISOString() },
    });
    return draft;
  });

  return {
    bundle,
    signature: signEdgeBootstrapBundle(bundle, presented.hash),
  };
}
