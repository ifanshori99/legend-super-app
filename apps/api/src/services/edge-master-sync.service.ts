// Edge master sync snapshot, cloud side (bead legend-9ppw; PRD v1.7 §3 F5
// "Server Lokal"). The edge node posts stock movements against stock
// locations that must exist in the cloud with the same ids, so it pulls the
// masters it needs: uoms (tenant-wide), stock locations (its outlet only),
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
import { and, asc, eq } from "drizzle-orm";
import { CoreError } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import {
  EDGE_MASTER_SNAPSHOT_VERSION,
  edgeMasterSnapshotSchema,
  type EdgeMasterSnapshotResponse,
} from "@starter/shared/edge/master-sync";
import { db } from "../db/index.ts";
import { parseEdgeCredential } from "../edge/credential.ts";
import { accountMappings, chartOfAccounts } from "../db/schema/accounting.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { stockLocations, uoms } from "../db/schema/inventory.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { signEdgeBootstrapBundle } from "./edge-bootstrap.service.ts";
import {
  verifiedEdgeNodeSchema,
  type VerifiedEdgeNode,
} from "./staff-pin-sync.ts";

const denied = () =>
  new CoreError(
    "FORBIDDEN",
    "Edge node tidak dapat mengambil data master outlet ini.",
  );

/**
 * The signed master snapshot for one verified edge node. `presentedCredential`
 * is the bearer token that `verifyEdgeCredential` accepted for `node`.
 */
export async function buildEdgeMasterSnapshot(
  node: VerifiedEdgeNode,
  presentedCredential: string,
): Promise<EdgeMasterSnapshotResponse> {
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

  const snapshot = await withTenant(db, context, async (tx) => {
    const [tenant] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const [outlet] = await tx
      .select({
        legalEntityId: outlets.legalEntityId,
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
      version: EDGE_MASTER_SNAPSHOT_VERSION,
      issuedAt: new Date().toISOString(),
      tenantId,
      outletId,
      legalEntityId,
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

  return {
    snapshot,
    signature: signEdgeBootstrapBundle(snapshot, presented.hash),
  };
}
