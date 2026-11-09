// Edge bootstrap, edge side (bead legend-khu5; PRD v1.7 §3 F5 "Server
// Lokal", TEN-02). A freshly installed edge node has an empty local
// database, so ensureLocalEdgeNode would fail on the tenant/outlet foreign
// keys. Before that, `bootstrapEdgeNodeIfNeeded` fetches the signed bundle
// from GET /api/edge-sync/bootstrap and inserts the rows it names.
//
// - Tenant AND outlet already present locally -> no-op (no network call).
// - The signature is checked over the bundle exactly as received (constant
//   time, key = the credential's own digest), then its shape, then that its
//   tenant/outlet are the credential's claims. Anything else -> EdgeBootError
//   and the node stays down, as it did before this bead.
//   The signature is an integrity check against corruption and misrouting,
//   not proof of origin: see "What the signature does NOT prove" in
//   packages/shared/src/edge/bootstrap.ts. Authenticity comes from TLS
//   (config.ts requires wss:// outside development; cloud-http.ts fetches
//   over https://). Not a pattern for cloud->edge commands (those need an
//   Ed25519 cloud key pinned on the edge).
// - One transaction, FK order tenant -> legal entity -> brand -> outlet,
//   `onConflictDoNothing` (an existing row is never overwritten).
//
// Never log the credential: errors carry a code only.
import { and, eq } from "drizzle-orm";
import {
  EDGE_BOOTSTRAP_PATH,
  edgeBootstrapBundleSchema,
  type EdgeBootstrapBundle,
} from "@starter/shared/edge";
import type {
  FeatureFlags,
  Geofence,
  OpeningHours,
  TenantLimits,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  brands,
  legalEntities,
  outlets,
  tenants,
} from "../db/schema/platform-org.ts";
import { guardDataImport } from "../config/data-import.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { edgeBootstrapSignatureMatches } from "../services/edge-bootstrap.service.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import { cloudGetJson, EdgeCloudHttpError } from "./cloud-http.ts";
import type { EdgeRuntimeConfig } from "./config.ts";
import { parseEdgeCredential } from "./credential.ts";
import { EdgeBootError } from "./runtime.ts";

export type EdgeBootstrapConfig = Pick<
  Extract<EdgeRuntimeConfig, { edgeMode: true }>,
  "cloudUrl" | "credential"
>;

export type EdgeBootstrapOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type EdgeBootstrapResult = "present" | "bootstrapped";

type Claims = NonNullable<ReturnType<typeof parseEdgeCredential>>;

async function localRowsPresent(claims: Claims): Promise<boolean> {
  return withTenant(db, edgeNodeContext(claims), async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, claims.tenantId))
      .limit(1);
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, claims.tenantId),
          eq(outlets.id, claims.outletId),
        ),
      )
      .limit(1);
    return tenant !== undefined && outlet !== undefined;
  });
}

function bootError(reason: string): EdgeBootError {
  return new EdgeBootError(
    `Data awal edge node tidak dapat dipasang (${reason}). / The edge node bootstrap failed (${reason}).`,
  );
}

async function fetchVerifiedBundle(
  config: EdgeBootstrapConfig,
  claims: Claims,
  options: EdgeBootstrapOptions,
): Promise<EdgeBootstrapBundle> {
  let body: unknown;
  try {
    body = await cloudGetJson({
      cloudUrl: config.cloudUrl,
      credential: config.credential,
      path: EDGE_BOOTSTRAP_PATH,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    throw bootError(
      error instanceof EdgeCloudHttpError
        ? `cloud ${error.code}`
        : "cloud request",
    );
  }
  if (body === null || typeof body !== "object")
    throw bootError("BAD_RESPONSE");
  const { bundle, signature } = body as {
    bundle?: unknown;
    signature?: unknown;
  };
  if (!edgeBootstrapSignatureMatches(bundle, signature, claims.hash))
    throw bootError("BAD_SIGNATURE");
  const parsed = edgeBootstrapBundleSchema.safeParse(bundle);
  if (!parsed.success) throw bootError("BAD_BUNDLE");
  if (
    parsed.data.tenant.id.toLowerCase() !== claims.tenantId.toLowerCase() ||
    parsed.data.outlet.id.toLowerCase() !== claims.outletId.toLowerCase()
  )
    throw bootError("SCOPE_MISMATCH");
  return parsed.data;
}

async function insertBundle(
  claims: Claims,
  bundle: EdgeBootstrapBundle,
): Promise<void> {
  const { tenant, legalEntity, outlet } = bundle;
  await withTenant(db, edgeNodeContext(claims), async (tx) => {
    await tx
      .insert(tenants)
      .values({
        ...tenant,
        // JSONB copied as the cloud stores it (see the shared contract).
        featureFlags: tenant.featureFlags as FeatureFlags,
        limits: tenant.limits as TenantLimits,
        createdAt: new Date(tenant.createdAt),
      })
      .onConflictDoNothing();
    await tx
      .insert(legalEntities)
      .values({
        ...legalEntity,
        npwpEncrypted: null,
        npwpLast4: null,
        npwpHash: null,
        createdAt: new Date(legalEntity.createdAt),
      })
      .onConflictDoNothing();
    await tx
      .insert(brands)
      .values(
        bundle.brands.map((brand) => ({
          ...brand,
          createdAt: new Date(brand.createdAt),
        })),
      )
      .onConflictDoNothing();
    await tx
      .insert(outlets)
      .values({
        ...outlet,
        geofence: outlet.geofence as Geofence | null,
        openingHours: outlet.openingHours as OpeningHours,
        regionId: null,
        createdAt: new Date(outlet.createdAt),
      })
      .onConflictDoNothing();
  });
}

/**
 * Edge boot, before ensureLocalEdgeNode: make sure the credential's tenant
 * and outlet rows exist locally. Throws EdgeBootError when they are missing
 * and cannot be fetched, verified or inserted.
 */
export async function bootstrapEdgeNodeIfNeeded(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions = {},
): Promise<EdgeBootstrapResult> {
  const claims = parseEdgeCredential(config.credential);
  if (!claims) throw bootError("EDGE_NODE_CREDENTIAL");
  if (await localRowsPresent(claims)) return "present";
  // Data import guard (legend-v4ld/legend-rhwb): this node's own deployment
  // policy must allow the rows (real data only in production). It does not
  // compare the cloud's environment with the node's: the bundle does not
  // declare one (follow-up bead). Report the reason as a boot code.
  try {
    guardDataImport("edge.bootstrap");
  } catch {
    throw bootError("DATA_IMPORT_BLOCKED");
  }

  const bundle = await fetchVerifiedBundle(config, claims, options);
  try {
    await insertBundle(claims, bundle);
  } catch {
    // Driver errors can carry SQL parameters: report a code only.
    throw bootError("LOCAL_INSERT");
  }
  // An existing conflicting row (e.g. same outlet code, other id) skips the
  // insert silently; the outlet must be there now or the node stays down.
  if (!(await localRowsPresent(claims))) throw bootError("LOCAL_CONFLICT");
  logger.info(
    { tenantId: claims.tenantId, outletId: claims.outletId },
    "Edge bootstrap bundle applied",
  );
  return "bootstrapped";
}
