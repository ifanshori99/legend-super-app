// Edge master sync snapshot, cloud side (bead legend-9ppw; PRD v1.7 §3 F5
// "Server Lokal"). The edge node posts stock movements against stock
// locations that must exist in the cloud with the same ids, so it pulls the
// masters it needs: brands (every brand of the tenant, so recipes of another
// brand have their FK parent), uoms (tenant-wide), stock locations (its outlet only),
// and the chart of accounts with its posting-role mappings (its outlet's
// legal entity only). Contract: packages/shared/src/edge/master-sync.ts.
//
// - Same trust model as edge-bootstrap.service.ts: tenant and outlet come
//   from the verified credential only, every query filters on them inside the
//   node's outlet-scoped tenant context, fail closed (FORBIDDEN) for an
//   inactive tenant, closed or unknown outlet, or a node not active on that
//   outlet. Signed with the digest of the credential actually presented
//   (integrity and misrouting only; authenticity comes from TLS).
// - Full snapshot, deterministic order (id, or code for accounts), parsed
//   with the shared schema before it is signed.
import { and, asc, DrizzleQueryError, eq, gt, ne } from "drizzle-orm";
import { DatabaseError } from "pg";
import { brandIdSchema, CoreError, type BrandId } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  EDGE_MASTER_SNAPSHOT_MIN_VERSION,
  EDGE_MASTER_SNAPSHOT_VERSION,
  EDGE_MASTER_BRANDS_PAGE_SIZE,
  edgeMasterSnapshotSchema,
  type EdgeMasterSnapshotResponse,
} from "@starter/shared/edge/master-sync";
import { db } from "../db/index.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import { accountMappings, chartOfAccounts } from "../db/schema/accounting.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { stockLocations, uoms } from "../db/schema/inventory.ts";
import { brands, outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { outletContext } from "./device-pin-support.ts";
import { signEdgeBootstrapBundle } from "./edge-bootstrap.service.ts";
import {
  verifiedEdgeNodeSchema,
  type VerifiedEdgeNode,
} from "./staff-pin-sync.ts";

/**
 * Codex 124: a failed read (query timeout, lost connection) surfaces as a
 * DrizzleQueryError whose message carries the SQL and the bound tenant, outlet
 * and node ids, and the error handler would log it through res.err. Refuse
 * with a fixed 503 instead: no message text, no `cause`. The log line holds
 * only the error class and the SQLSTATE, never the query or its parameters.
 * Only database errors take this path: anything else (an unsafe database role
 * refused by withTenant, a code bug) keeps the 500 path, whose res.err copy
 * the error handler already scrubs of row values.
 */
function isDatabaseError(error: unknown): boolean {
  return error instanceof DrizzleQueryError || error instanceof DatabaseError;
}

function masterReadFailed(error: unknown): CoreError {
  const source = error instanceof DrizzleQueryError ? error.cause : error;
  const sqlState = (source as { code?: unknown } | null | undefined)?.code;
  logger.warn(
    {
      errorClass:
        error instanceof Error ? error.constructor.name : typeof error,
      sqlState: typeof sqlState === "string" ? sqlState : undefined,
    },
    "edge master snapshot: database read failed",
  );
  return new CoreError(
    "SERVICE_UNAVAILABLE",
    "Data master outlet belum dapat dibaca. Coba lagi sebentar.",
  );
}

const denied = () =>
  new CoreError(
    "FORBIDDEN",
    "Edge node tidak dapat mengambil data master outlet ini.",
  );

type SnapshotOptions = {
  snapshotVersion?: number;
  brandPage?: boolean;
  brandCursor?: BrandId;
};

/**
 * The signed master snapshot for one verified edge node. `presentedCredential`
 * is the bearer token that `verifyEdgeCredential` accepted for `node`.
 */
export async function buildEdgeMasterSnapshot(
  node: VerifiedEdgeNode,
  presentedCredential: string,
  options: SnapshotOptions = {},
): Promise<EdgeMasterSnapshotResponse> {
  // Version 2 (brands) only for an edge that asked; an older edge accepts the
  // literal version 1 only, so the default is exactly the old snapshot.
  const version =
    (options.snapshotVersion ?? 0) >= EDGE_MASTER_SNAPSHOT_VERSION
      ? EDGE_MASTER_SNAPSHOT_VERSION
      : EDGE_MASTER_SNAPSHOT_MIN_VERSION;
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

  if (
    (options.brandPage && version < 2) ||
    (options.brandCursor !== undefined && !options.brandPage)
  )
    throw new CoreError("VALIDATION_ERROR", "Kursor brand tidak valid.");
  const snapshot = await readSnapshot(context, verified, version, options);

  return {
    snapshot,
    signature: signEdgeBootstrapBundle(snapshot, presented.hash),
  };
}

type SnapshotScope = Pick<
  VerifiedEdgeNode,
  "tenantId" | "outletId" | "edgeNodeId"
>;

async function readSnapshot(
  context: ReturnType<typeof outletContext>,
  scope: SnapshotScope,
  version: number,
  options: SnapshotOptions,
) {
  try {
    return await readSnapshotInTenant(context, scope, version, options);
  } catch (error) {
    if (!isDatabaseError(error)) throw error;
    throw masterReadFailed(error);
  }
}

function readSnapshotInTenant(
  context: ReturnType<typeof outletContext>,
  { tenantId, outletId, edgeNodeId }: SnapshotScope,
  version: number,
  options: SnapshotOptions,
) {
  return withTenant(db, context, async (tx) => {
    const [tenant] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [outlet] = await tx
      .select({
        legalEntityId: outlets.legalEntityId,
        brandId: outlets.brandId,
        status: outlets.status,
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
    const { legalEntityId } = outlet;

    let brandRows: (typeof brands.$inferSelect)[] = [];
    let nextBrandCursor: BrandId | undefined;
    let responseVersion = version;
    if (version >= 2 && options.brandPage) {
      // A cursor is an existing non-outlet brand in this tenant. An arbitrary
      // or foreign id must not silently skip some of this tenant's brands.
      if (options.brandCursor !== undefined) {
        const [cursor] = await tx
          .select({ id: brands.id })
          .from(brands)
          .where(
            and(
              eq(brands.tenantId, tenantId),
              eq(brands.id, options.brandCursor),
              ne(brands.id, outlet.brandId),
            ),
          )
          .limit(1);
        if (!cursor)
          throw new CoreError("VALIDATION_ERROR", "Kursor brand tidak valid.");
      }
      const [ownBrand] = await tx
        .select()
        .from(brands)
        .where(
          and(eq(brands.tenantId, tenantId), eq(brands.id, outlet.brandId)),
        )
        .limit(1);
      if (!ownBrand) throw denied();
      const page = await tx
        .select()
        .from(brands)
        .where(
          and(
            eq(brands.tenantId, tenantId),
            ne(brands.id, outlet.brandId),
            options.brandCursor === undefined
              ? undefined
              : gt(brands.id, options.brandCursor),
          ),
        )
        .orderBy(asc(brands.id))
        // Reserve one slot for the outlet brand. The extra row is lookahead.
        .limit(EDGE_MASTER_BRANDS_PAGE_SIZE);
      const others = page.slice(0, EDGE_MASTER_BRANDS_PAGE_SIZE - 1);
      brandRows = [ownBrand, ...others];
      const lastOther = others[others.length - 1];
      if (page.length === EDGE_MASTER_BRANDS_PAGE_SIZE && lastOther)
        nextBrandCursor = brandIdSchema.parse(lastOther.id);
    } else if (version >= 2) {
      brandRows = await tx
        .select()
        .from(brands)
        .where(eq(brands.tenantId, tenantId))
        .orderBy(asc(brands.id))
        .limit(EDGE_MASTER_BRANDS_PAGE_SIZE + 1);
      // Older edges understand a complete v1 snapshot. Do not send a silent
      // partial brand list or lose all non-brand masters on a large tenant.
      if (brandRows.length > EDGE_MASTER_BRANDS_PAGE_SIZE) {
        responseVersion = EDGE_MASTER_SNAPSHOT_MIN_VERSION;
        brandRows = [];
      }
    }
    const uomRows = await tx
      .select()
      .from(uoms)
      .where(eq(uoms.tenantId, tenantId))
      .orderBy(asc(uoms.id));
    const locationRows = await tx
      .select()
      .from(stockLocations)
      .where(
        and(
          eq(stockLocations.tenantId, tenantId),
          eq(stockLocations.outletId, outletId),
        ),
      )
      .orderBy(asc(stockLocations.id));
    const accountRows = await tx
      .select()
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(chartOfAccounts.code), asc(chartOfAccounts.id));
    const mappingRows = await tx
      .select()
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.tenantId, tenantId),
          eq(accountMappings.legalEntityId, legalEntityId),
        ),
      )
      .orderBy(asc(accountMappings.role));

    const parsed = edgeMasterSnapshotSchema.safeParse({
      version: responseVersion,
      issuedAt: new Date().toISOString(),
      tenantId,
      outletId,
      legalEntityId,
      ...(responseVersion >= 2
        ? {
            brandId: outlet.brandId,
            ...(nextBrandCursor === undefined ? {} : { nextBrandCursor }),
            brands: brandRows.map((row) => ({
              id: row.id,
              tenantId: row.tenantId,
              slug: row.slug,
              name: row.name,
              logoMediaId: row.logoMediaId,
              themeId: row.themeId,
              createdAt: row.createdAt.toISOString(),
            })),
          }
        : {}),
      uoms: uomRows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        code: row.code,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      })),
      stockLocations: locationRows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        name: row.name,
        type: row.type,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
      })),
      chartOfAccounts: accountRows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        legalEntityId: row.legalEntityId,
        code: row.code,
        name: row.name,
        type: row.type,
        reportGroup: row.reportGroup,
        parentId: row.parentId,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      accountMappings: mappingRows.map((row) => ({
        tenantId: row.tenantId,
        legalEntityId: row.legalEntityId,
        role: row.role,
        accountId: row.accountId,
      })),
    });
    // Over a contract cap (or a row the contract refuses): an explicit 409,
    // not an unhandled 500, so the edge reports a clear cloud code.
    if (!parsed.success)
      throw new CoreError(
        "CONFLICT",
        "Data master outlet melebihi batas sinkronisasi edge.",
      );
    return parsed.data;
  });
}
