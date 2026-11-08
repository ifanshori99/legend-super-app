// Edge node registry (bead legend-2pi; PRD v1.7 §3 F5 "Server Lokal", R10
// primary + standby, §6 A `edge_nodes`, EDG-03 revocation).
//
// - register: a holder of `device.registry.manage` on the outlet registers a
//   mini PC as `primary` or `standby` (at most one active of each per
//   outlet). The link credential is minted here and returned ONCE; only its
//   bound SHA-256 digest is stored (edge/credential.ts). Audited.
// - revoke: `device.registry.revoke`; terminal (database trigger), audited,
//   and every open link of the node is closed through the revocation
//   listeners (link server) and, for other API instances, a NOTIFY on
//   EDGE_NODE_REVOKED_CHANNEL sent from the revoke transaction (legend-x3lv);
//   the periodic re-check still covers a missed notification.
// - rotate (legend-x3lv): `device.registry.revoke`; a new credential returned
//   ONCE, the replaced digest still accepted for the grace period
//   (EDGE_CREDENTIAL_ROTATION_GRACE_HOURS), then refused and its open link
//   closed by the re-check. Audited like revoke.
// - authenticate: the cloud link's credential check. The tenant must be
//   active, the outlet not closed, the node active, the credential digest
//   equal (constant time) to the current digest, or to the previous one
//   while its grace period lasts.
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
  type TenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { edgeNodeSchema, type EdgeNode } from "@starter/shared/edge";
import { parseEdgeHardeningEnv } from "@starter/shared/env";
import { db } from "../db/index.ts";
import { edgeNodes, type EdgeNodeRole } from "../db/schema/edge-node.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
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

/**
 * NOTIFY channel for revocations (legend-x3lv): the payload is the edge node
 * id only. Sent inside the revoke transaction, so it is delivered on commit;
 * every API instance LISTENs and closes its link to that node.
 */
export const EDGE_NODE_REVOKED_CHANNEL = "edge_node_revoked";

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
    await tx.execute(
      sql`SELECT pg_notify(${EDGE_NODE_REVOKED_CHANNEL}, ${current.id})`,
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

/**
 * The outlet of an edge node, read under tenant-wide RLS so a route can check
 * the permission on that outlet. null = unknown node (or another tenant's):
 * the caller answers 404 without saying which.
 */
export async function findEdgeNodeOutletId(
  tenant: TenantContext,
  edgeNodeId: string,
): Promise<string | null> {
  const context = establishScopedTenantContext(tenant, { kind: "tenant" });
  const [row] = await withTenant(db, context, (tx) =>
    tx
      .select({ outletId: edgeNodes.outletId })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, tenant.tenantId),
          eq(edgeNodes.id, edgeNodeId),
        ),
      )
      .limit(1),
  );
  return row?.outletId ?? null;
}

/**
 * Credential rotation (legend-x3lv). Only an active node; the new credential
 * is returned ONCE and never logged or audited. The replaced digest stays
 * valid until `previousCredentialExpiresAt`; rotating again replaces it (the
 * credential before that stops working at once).
 */
export async function rotateEdgeNodeCredential(
  context: ScopedTenantContext,
  actorUserId: string,
  edgeNodeId: string,
  now: Date = new Date(),
): Promise<{
  edgeNode: EdgeNodeAdminView;
  credential: string;
  previousCredentialExpiresAt: string;
}> {
  assertTrustedScopedContext(context);
  const graceHours = parseEdgeHardeningEnv(
    process.env,
  ).EDGE_CREDENTIAL_ROTATION_GRACE_HOURS;
  const expiresAt = new Date(now.getTime() + graceHours * 3_600_000);
  const result = await withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, context.tenant.tenantId),
          eq(edgeNodes.id, edgeNodeId),
        ),
      )
      .for("update");
    if (!current)
      throw new CoreError("NOT_FOUND", "Edge node tidak ditemukan.");
    assertOutletInScope(context.outletScope, current.outletId);
    if (current.status !== "active")
      throw new CoreError(
        "CONFLICT",
        "Edge node sudah dicabut; kredensialnya tidak dapat diganti.",
      );
    const { token, hash } = mintEdgeCredential({
      tenantId: current.tenantId,
      outletId: current.outletId,
      edgeNodeId: current.id,
    });
    const [updated] = await tx
      .update(edgeNodes)
      .set({
        credentialHash: hash,
        credentialIssuedAt: now,
        previousCredentialHash: current.credentialHash,
        previousCredentialExpiresAt: expiresAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(edgeNodes.tenantId, context.tenant.tenantId),
          eq(edgeNodes.id, current.id),
          eq(edgeNodes.status, "active"),
        ),
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
        action: "edge_node.credential_rotated",
        objectType: "edge_node",
        objectId: current.id,
        reason: null,
        before: {
          credentialIssuedAt: current.credentialIssuedAt.toISOString(),
        },
        after: {
          credentialIssuedAt: now.toISOString(),
          previousCredentialExpiresAt: expiresAt.toISOString(),
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return { row: updated, token };
  });
  return {
    edgeNode: toAdminView(result.row),
    credential: result.token,
    previousCredentialExpiresAt: expiresAt.toISOString(),
  };
}

/**
 * The stored digest the presented one matches: the current credential, or
 * the previous one while its rotation grace lasts. Null for no match.
 */
function matchingCredentialHash(
  presentedHash: string,
  row: {
    credentialHash: string;
    previousCredentialHash: string | null;
    previousCredentialExpiresAt: Date | null;
  },
  now: Date,
): string | null {
  if (edgeCredentialMatches(presentedHash, row.credentialHash))
    return row.credentialHash;
  if (
    row.previousCredentialHash &&
    row.previousCredentialExpiresAt &&
    row.previousCredentialExpiresAt.getTime() > now.getTime() &&
    edgeCredentialMatches(presentedHash, row.previousCredentialHash)
  )
    return row.previousCredentialHash;
  return null;
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
  /** The stored digest this link authenticated with (current or previous). */
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
 * malformed token, unknown/inactive tenant, closed outlet, unknown node,
 * other outlet, revoked node, digest mismatch, expired previous credential.
 */
export async function authenticateEdgeCredential(
  token: string,
  now: Date = new Date(),
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
        previousCredentialHash: edgeNodes.previousCredentialHash,
        previousCredentialExpiresAt: edgeNodes.previousCredentialExpiresAt,
      })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, claims.tenantId),
          eq(edgeNodes.id, claims.edgeNodeId),
        ),
      )
      .limit(1),
  );
  // Same outlet rule as the re-check (isEdgeNodeActive), so connect and
  // re-check agree (legend-wg5t): a closed outlet cannot open a link.
  if (row && (await isOutletClosed(context, claims.outletId))) return null;
  if (!row || row.outletId !== claims.outletId || row.status !== "active")
    return null;
  const credentialHash = matchingCredentialHash(claims.hash, row, now);
  if (!credentialHash) return null;
  return {
    scope: {
      tenantId: claims.tenantId,
      outletId: claims.outletId,
      edgeNodeId: claims.edgeNodeId,
    },
    context,
    credentialHash,
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
  const node = await authenticateEdgeCredential(
    input.credential,
    input.now ?? new Date(),
  );
  if (!node) return null;
  return {
    tenantId: tenantIdSchema.parse(node.scope.tenantId),
    outletId: outletIdSchema.parse(node.scope.outletId),
    edgeNodeId: node.scope.edgeNodeId,
  };
}

async function isOutletClosed(
  context: ScopedTenantContext,
  outletId: string,
): Promise<boolean> {
  const [outlet] = await withTenant(db, context, (tx) =>
    tx
      .select({ status: outlets.status })
      .from(outlets)
      .where(eq(outlets.id, outletId))
      .limit(1),
  );
  // A missing outlet row is treated as closed: fail closed.
  return !outlet || outlet.status === "closed";
}

/**
 * Re-check for an open link: still active with the same credential, and
 * (legend-wg5t) the tenant still `active` and the outlet not `closed`, so a
 * suspended tenant or closed outlet drops an already-open link at the next
 * periodic check, not only at the next connect. A link opened with a
 * credential that was rotated away stays up only until the grace period ends
 * (legend-x3lv), or at once when it is rotated a second time.
 */
export async function isEdgeNodeActive(
  node: AuthenticatedEdgeNode,
  now: Date = new Date(),
): Promise<boolean> {
  const [tenant] = await db
    .select({ status: tenants.status })
    .from(tenants)
    .where(eq(tenants.id, node.scope.tenantId))
    .limit(1);
  if (tenant?.status !== "active") return false;
  if (await isOutletClosed(node.context, node.scope.outletId)) return false;
  const [row] = await withTenant(db, node.context, (tx) =>
    tx
      .select({
        status: edgeNodes.status,
        credentialHash: edgeNodes.credentialHash,
        previousCredentialHash: edgeNodes.previousCredentialHash,
        previousCredentialExpiresAt: edgeNodes.previousCredentialExpiresAt,
      })
      .from(edgeNodes)
      .where(
        and(
          eq(edgeNodes.tenantId, node.context.tenant.tenantId),
          eq(edgeNodes.id, node.scope.edgeNodeId),
        ),
      )
      .limit(1),
  );
  if (row?.status !== "active") return false;
  if (row.credentialHash === node.credentialHash) return true;
  return (
    row.previousCredentialHash === node.credentialHash &&
    row.previousCredentialExpiresAt !== null &&
    row.previousCredentialExpiresAt.getTime() > now.getTime()
  );
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
