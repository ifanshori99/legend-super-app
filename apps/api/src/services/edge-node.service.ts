// Edge node registry (bead legend-2pi; PRD v1.7 §3 F5 "Server Lokal", R10
// primary + standby, §6 A `edge_nodes`, EDG-03 revocation).
//
// - register: a holder of `device.registry.manage` on the outlet registers a
//   mini PC as `primary` or `standby` (at most one active of each per
//   outlet). The link credential is minted here and returned ONCE; only its
//   bound SHA-256 digest is stored (edge/credential.ts). Audited.
// - revoke: `device.registry.revoke`; terminal (database trigger), audited,
//   and every open link of the node is closed through the revocation
//   listeners (link server), with the periodic re-check covering other API
//   instances.
// - authenticate: the cloud link's credential check. The tenant must be
//   active, the node active, the credential digest equal (constant time).
// - ensureLocalEdgeNode: on the edge itself, the node's own row (needed by
//   the link tables' foreign keys), created from its credential at boot.
//
// Never log or audit the credential.
import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  outletIdSchema,
  tenantIdSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { edgeNodeSchema, type EdgeNode } from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { edgeNodes, type EdgeNodeRole } from "../db/schema/edge-node.ts";
import { tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import {
  edgeCredentialMatches,
  mintEdgeCredential,
  parseEdgeCredential,
} from "../edge/credential.ts";
import type { LinkScope } from "../edge/link-peer.ts";
import { recordAudit } from "./audit-writer.ts";

type EdgeNodeRow = typeof edgeNodes.$inferSelect;

export function toEdgeNode(row: EdgeNodeRow): EdgeNode {
  return edgeNodeSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    id: row.id,
    role: row.role,
    version: row.version,
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    lastSyncCursor: row.lastSyncCursor,
  });
}

export type EdgeNodeAdminView = EdgeNode & {
  label: string;
  status: "active" | "revoked";
  revokedAt: string | null;
};

function toAdminView(row: EdgeNodeRow): EdgeNodeAdminView {
  return {
    ...toEdgeNode(row),
    label: row.label,
    status: row.status,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function uniqueViolation(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

export type RegisterEdgeNodeInput = {
  outletId: string;
  role: EdgeNodeRole;
  label: string;
};

export async function registerEdgeNode(
  context: ScopedTenantContext,
  actorUserId: string,
  input: RegisterEdgeNodeInput,
): Promise<{ edgeNode: EdgeNodeAdminView; credential: string }> {
  assertTrustedScopedContext(context);
  const outletId = outletIdSchema.parse(input.outletId);
  assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const id = randomUUID();
  const { token, hash } = mintEdgeCredential({
    tenantId,
    outletId,
    edgeNodeId: id,
  });
  try {
    const row = await withTenant(db, context, async (tx) => {
      const [inserted] = await tx
        .insert(edgeNodes)
        .values({
          id,
          tenantId,
          outletId,
          role: input.role,
          label: input.label,
          credentialHash: hash,
          registeredBy: actorUserId,
        })
        .returning();
      if (!inserted) throw new Error("Edge node insert returned nothing");
      await recordAudit(
        {
          tenantId,
          outletId,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "edge_node.registered",
          objectType: "edge_node",
          objectId: id,
          reason: null,
          before: null,
          after: { role: input.role, label: input.label },
          sensitiveAccess: false,
        },
        { tx, context },
      );
      return inserted;
    });
    return { edgeNode: toAdminView(row), credential: token };
  } catch (error) {
    if (uniqueViolation(error))
      throw new CoreError(
        "CONFLICT",
        "Outlet ini sudah memiliki edge node aktif dengan peran tersebut.",
      );
    throw error;
  }
}

type RevocationListener = (edgeNodeId: string) => void;
const revocationListeners = new Set<RevocationListener>();

/** The link server subscribes to close a revoked node's link at once. */
export function onEdgeNodeRevoked(listener: RevocationListener): () => void {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

export async function revokeEdgeNode(
  context: ScopedTenantContext,
  actorUserId: string,
  input: { edgeNodeId: string; reason: string },
): Promise<EdgeNodeAdminView> {
  assertTrustedScopedContext(context);
  const row = await withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(edgeNodes)
      .where(eq(edgeNodes.id, input.edgeNodeId))
      .for("update");
    if (!current)
      throw new CoreError("NOT_FOUND", "Edge node tidak ditemukan.");
    assertOutletInScope(context.outletScope, current.outletId);
    if (current.status === "revoked") return current; // idempotent
    const [updated] = await tx
      .update(edgeNodes)
      .set({
        status: "revoked",
        revokedAt: new Date(),
        revokedBy: actorUserId,
        revokeReason: input.reason,
        updatedAt: new Date(),
      })
      .where(
        and(eq(edgeNodes.id, input.edgeNodeId), eq(edgeNodes.status, "active")),
      )
      .returning();
    if (!updated)
      throw new CoreError("CONFLICT", "Edge node berubah, coba lagi.");
    await recordAudit(
      {
        tenantId: current.tenantId,
        outletId: current.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "edge_node.revoked",
        objectType: "edge_node",
        objectId: current.id,
        reason: input.reason,
        before: { status: "active" },
        after: { status: "revoked" },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return updated;
  });
  for (const listener of revocationListeners) {
    try {
      listener(row.id);
    } catch {
      // A listener failure must not undo a committed revocation; the
      // periodic re-check still closes the link.
    }
  }
  return toAdminView(row);
}

export async function listEdgeNodes(
  context: ScopedTenantContext,
  filter: { outletId?: OutletId } = {},
): Promise<EdgeNodeAdminView[]> {
  assertTrustedScopedContext(context);
  if (filter.outletId)
    assertOutletInScope(context.outletScope, filter.outletId);
  const rows = await withTenant(db, context, (tx) =>
    tx
      .select()
      .from(edgeNodes)
      .where(
        filter.outletId ? eq(edgeNodes.outletId, filter.outletId) : undefined,
      )
      .orderBy(asc(edgeNodes.createdAt), asc(edgeNodes.id))
      .limit(100),
  );
  return rows.map(toAdminView);
}

export async function getEdgeNode(
  context: ScopedTenantContext,
  edgeNodeId: string,
): Promise<EdgeNode | null> {
  const [row] = await withTenant(db, context, (tx) =>
    tx.select().from(edgeNodes).where(eq(edgeNodes.id, edgeNodeId)).limit(1),
  );
  return row ? toEdgeNode(row) : null;
}

/** The server-minted context of one node: its tenant, its outlet only. */
export function edgeNodeContext(claims: {
  tenantId: string;
  outletId: string;
}): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: claims.tenantId,
      brandId: null,
      source: "device",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(claims.outletId)] },
  );
}

export type AuthenticatedEdgeNode = {
  readonly scope: LinkScope;
  readonly context: ScopedTenantContext;
  readonly credentialHash: string;
};

/**
 * Port for other cloud endpoints the edge calls with its credential (e.g.
 * the staff pin down-sync at /api/edge-sync/staff-pin-records): pass
 * `authenticateEdgeCredential`. `scope` is the node's tenant/outlet/node,
 * `context` the server-minted outlet-scoped tenant context.
 */
export type EdgeCredentialVerifier = (
  credential: string,
) => Promise<AuthenticatedEdgeNode | null>;

/**
 * Cloud link credential check. Every refusal is the same null (no oracle):
 * malformed token, unknown/inactive tenant, unknown node, other outlet,
 * revoked node, digest mismatch.
 */
export async function authenticateEdgeCredential(
  token: string,
): Promise<AuthenticatedEdgeNode | null> {
  const claims = parseEdgeCredential(token);
  if (!claims) return null;
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, claims.tenantId))
    .limit(1);
  if (tenant?.status !== "active") return null;
  const context = edgeNodeContext(claims);
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select({
        outletId: edgeNodes.outletId,
        status: edgeNodes.status,
        credentialHash: edgeNodes.credentialHash,
      })
      .from(edgeNodes)
      .where(eq(edgeNodes.id, claims.edgeNodeId))
      .limit(1),
  );
  if (
    !row ||
    row.outletId !== claims.outletId ||
    row.status !== "active" ||
    !edgeCredentialMatches(claims.hash, row.credentialHash)
  )
    return null;
  return {
    scope: {
      tenantId: claims.tenantId,
      outletId: claims.outletId,
      edgeNodeId: claims.edgeNodeId,
    },
    context,
    credentialHash: row.credentialHash,
  };
}

/**
 * Adapter for the staff pin down-sync port (staff-pin-sync.ts
 * `setEdgeCredentialVerifier`): the node's tenant/outlet/node or null.
 */
export async function verifyEdgeNodeCredential(input: {
  readonly credential: string;
  readonly now?: Date;
}): Promise<{
  tenantId: TenantId;
  outletId: OutletId;
  edgeNodeId: string;
} | null> {
  const node = await authenticateEdgeCredential(input.credential);
  if (!node) return null;
  return {
    tenantId: tenantIdSchema.parse(node.scope.tenantId),
    outletId: outletIdSchema.parse(node.scope.outletId),
    edgeNodeId: node.scope.edgeNodeId,
  };
}

/** Re-check for an open link: still active with the same credential. */
export async function isEdgeNodeActive(
  node: AuthenticatedEdgeNode,
): Promise<boolean> {
  const [row] = await withTenant(db, node.context, (tx) =>
    tx
      .select({
        status: edgeNodes.status,
        credentialHash: edgeNodes.credentialHash,
      })
      .from(edgeNodes)
      .where(eq(edgeNodes.id, node.scope.edgeNodeId))
      .limit(1),
  );
  return row?.status === "active" && row.credentialHash === node.credentialHash;
}

/** Heartbeat from the link (PRD §3 F5 Registri: heartbeat + versi). */
export async function recordEdgeHeartbeat(
  context: ScopedTenantContext,
  edgeNodeId: string,
  version: string,
): Promise<void> {
  await withTenant(db, context, (tx) =>
    tx
      .update(edgeNodes)
      .set({ lastHeartbeatAt: new Date(), version, updatedAt: new Date() })
      .where(and(eq(edgeNodes.id, edgeNodeId), eq(edgeNodes.status, "active"))),
  );
}

/**
 * Edge boot: make sure the node's own row exists locally (link tables
 * reference it). The tenant and outlet rows must already be provisioned
 * (legend-16s / legend-97p); a missing one fails the insert's foreign key and
 * the runtime refuses to start the link.
 */
export async function ensureLocalEdgeNode(
  token: string,
  input: { role: EdgeNodeRole; version: string },
): Promise<{ context: ScopedTenantContext; scope: LinkScope; node: EdgeNode }> {
  const claims = parseEdgeCredential(token);
  if (!claims) throw new Error("EDGE_NODE_CREDENTIAL is malformed");
  const context = edgeNodeContext(claims);
  const row = await withTenant(db, context, async (tx) => {
    await tx
      .insert(edgeNodes)
      .values({
        id: claims.edgeNodeId,
        tenantId: claims.tenantId,
        outletId: claims.outletId,
        role: input.role,
        label: "local",
        version: input.version,
        credentialHash: claims.hash,
      })
      .onConflictDoNothing();
    await tx
      .update(edgeNodes)
      .set({
        version: input.version,
        lastHeartbeatAt: sql`now()`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(edgeNodes.id, claims.edgeNodeId),
          eq(edgeNodes.status, "active"),
        ),
      );
    const [current] = await tx
      .select()
      .from(edgeNodes)
      .where(eq(edgeNodes.id, claims.edgeNodeId))
      .limit(1);
    return current;
  });
  if (!row || row.outletId !== claims.outletId)
    throw new Error("The local edge node row does not match the credential");
  if (row.status !== "active")
    throw new Error(
      "This edge node is revoked; re-provision it from the cloud",
    );
  return {
    context,
    scope: {
      tenantId: claims.tenantId,
      outletId: claims.outletId,
      edgeNodeId: claims.edgeNodeId,
    },
    node: toEdgeNode(row),
  };
}
