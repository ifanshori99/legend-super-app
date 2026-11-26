// Who serves an outlet's POS (1269 E3): the cloud, or the outlet's own edge.
// An outlet with an active primary edge sells, runs its drawers and opens its
// shifts on that edge ONLY (one cashier writer, PRD F5). A cloud write there
// would put a second sale or a second drawer beside the edge's, so the cloud
// refuses it, also while the edge is unreachable: selling in the cloud is never
// a shortcut for a dead edge. Any active node counts (same rule as
// pos-receipt): in doubt the cloud refuses. An outlet without an active edge
// node (none, revoked) is unchanged.
//
// Failover (1271 F3, D4; CTO 27 Nov): while a manager's failover window of the
// outlet is `active` (and EDGE_FAILOVER_ENABLED is on) the cloud serves ONLY
// the core POS paths, named by the caller with `{ failover: "core" }`: cashier
// and captain orders, payment, shift and drawer, receipts, KDS/expo and the
// cashier sign-in. Every other caller keeps the default (refused): QR guests,
// table links, table sessions, order customer, delivery, order recovery,
// points and tickets. In `returning` the cloud refuses again. On the edge, a
// POS write is refused with FAILOVER_ACTIVE while its window copy is
// `active` or `returning`, so edge and cloud never sell at the same time.
import { and, eq, sql } from "drizzle-orm";
import {
  isOutletInScope,
  outletIdSchema,
  ulidSchema,
  ulidToUuid,
  uuidSchema,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { PosError } from "@starter/shared/pos";
import { env } from "../config/env.ts";
import { db } from "../db/index.ts";
import { memberTenantContext } from "../db/member-scope.ts";
import { outletFailoverWindows } from "../db/schema/edge-failover.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { tableSessions } from "../db/schema/floor.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { activeFailoverWindow } from "./edge-failover-window.ts";
import type { Tx } from "./permission-resolver.ts";

/** Same rule as pos-receipt: static EDGE_MODE counts in the boot window. */
export function isEdgeProcess(): boolean {
  return getEdgeRuntimeState().edgeMode || process.env.EDGE_MODE === "true";
}

export async function outletHasActiveEdge(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: edgeNodes.id })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, tenantId),
        eq(edgeNodes.outletId, outletId),
        eq(edgeNodes.status, "active"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

let isEdgeWriter: () => boolean = isEdgeProcess;

/** Test hook (like setSalesGateEdgeModeForTests); null restores the default. */
export function setPosWriteGateEdgeModeForTests(
  fn: (() => boolean) | null,
): void {
  isEdgeWriter = fn ?? isEdgeProcess;
}

/** D6 kill switch: anything but `true` is off (fail closed). */
export function edgeFailoverEnabled(): boolean {
  return env.EDGE_FAILOVER_ENABLED === true;
}

/**
 * The existing row a core write acts on. During a window the cloud writes
 * only rows of that window: an order, shift, receipt or kitchen ticket the
 * edge made stays the edge's (an unpaid edge bill is re-rung in the cloud).
 */
export type PosWriteTarget = {
  readonly kind:
    "order" | "shift" | "receipt" | "kitchen_ticket" | "kitchen_ticket_item";
  readonly id: string;
};

export type PosWriteGateOptions = {
  /**
   * `core`: a core POS path the cloud serves while the outlet's failover
   * window is `active` (cashier/captain order, payment, shift and drawer,
   * receipt, KDS/expo, cashier sign-in). Omitted: refused like any other
   * write of an edge outlet.
   */
  readonly failover?: "core";
  /** The row the write acts on (core writes on an existing row). */
  readonly target?: PosWriteTarget;
};

const ULID_TARGETS = new Set<PosWriteTarget["kind"]>([
  "order",
  "kitchen_ticket",
  "kitchen_ticket_item",
]);

/**
 * The target's failover window: `undefined` when the row is not found here
 * (the route answers its own 404), null for a row outside any window.
 */
async function targetWindowId(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  target: PosWriteTarget,
): Promise<string | null | undefined> {
  const parsed = ULID_TARGETS.has(target.kind)
    ? ulidSchema.safeParse(target.id)
    : uuidSchema.safeParse(target.id);
  if (!parsed.success) return undefined;
  const id = ULID_TARGETS.has(target.kind)
    ? ulidToUuid(parsed.data)
    : parsed.data;
  const query = {
    order: sql`SELECT failover_window_id AS window_id FROM pos_orders WHERE tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid AND order_id = ${id}::uuid`,
    shift: sql`SELECT failover_window_id AS window_id FROM pos_shifts WHERE tenant_id = ${tenantId}::uuid AND outlet_id = ${outletId}::uuid AND id = ${id}::uuid`,
    receipt: sql`SELECT po.failover_window_id AS window_id FROM pos_receipts r LEFT JOIN pos_orders po ON po.tenant_id = r.tenant_id AND po.order_id = r.order_id WHERE r.tenant_id = ${tenantId}::uuid AND r.outlet_id = ${outletId}::uuid AND r.id = ${id}::uuid`,
    kitchen_ticket: sql`SELECT po.failover_window_id AS window_id FROM kitchen_tickets t LEFT JOIN pos_orders po ON po.tenant_id = t.tenant_id AND po.order_id = t.order_id WHERE t.tenant_id = ${tenantId}::uuid AND t.outlet_id = ${outletId}::uuid AND t.id = ${id}::uuid`,
    kitchen_ticket_item: sql`SELECT po.failover_window_id AS window_id FROM kitchen_ticket_items i LEFT JOIN pos_orders po ON po.tenant_id = i.tenant_id AND po.order_id = i.order_id WHERE i.tenant_id = ${tenantId}::uuid AND i.outlet_id = ${outletId}::uuid AND i.id = ${id}::uuid`,
  }[target.kind];
  const result = await tx.execute(query);
  const row = result.rows[0];
  if (!row) return undefined;
  return (row.window_id as string | null) ?? null;
}

/**
 * True when the cloud must not write this outlet's POS rows: its edge does.
 * The default rule (no failover allowance); the delivery hold reads it.
 */
export async function posWritesOnEdge(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
): Promise<boolean> {
  if (isEdgeWriter()) return false;
  return outletHasActiveEdge(tx, tenantId, outletId);
}

/**
 * The one POS write gate (E3, E3b, 1271 F3). Returns the id of the `active`
 * failover window a core cloud write belongs to, or null for a normal write.
 * Throws 409 POS_WRITE_ON_EDGE for a cloud write the outlet's edge owns, and
 * 409 FAILOVER_ACTIVE on the edge while its window copy is open. The window
 * row is share-locked: a cancel or return started meanwhile waits for the
 * caller's transaction, then sees its order or shift.
 */
export async function posWriteFailoverWindowId(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  options: PosWriteGateOptions = {},
): Promise<string | null> {
  if (isEdgeWriter()) {
    if (await activeFailoverWindow(tx, tenantId, outletId))
      throw new PosError("FAILOVER_ACTIVE");
    return null;
  }
  if (!(await outletHasActiveEdge(tx, tenantId, outletId))) return null;
  if (options.failover === "core" && edgeFailoverEnabled()) {
    const [window] = await tx
      .select({ id: outletFailoverWindows.id })
      .from(outletFailoverWindows)
      .where(
        and(
          eq(outletFailoverWindows.tenantId, tenantId),
          eq(outletFailoverWindows.outletId, outletId),
          eq(outletFailoverWindows.status, "active"),
        ),
      )
      .limit(1)
      .for("share");
    if (window) {
      const target = options.target
        ? await targetWindowId(tx, tenantId, outletId, options.target)
        : undefined;
      // A row of the edge (or of an earlier window) stays refused.
      if (target !== undefined && target !== window.id)
        throw new PosError("POS_WRITE_ON_EDGE");
      return window.id;
    }
  }
  throw new PosError("POS_WRITE_ON_EDGE");
}

/** The gate without the window id (see posWriteFailoverWindowId). */
export async function assertPosWriteNotOnEdge(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  options: PosWriteGateOptions = {},
): Promise<void> {
  await posWriteFailoverWindowId(tx, tenantId, outletId, options);
}

/**
 * 409 POS_WRITE_ON_EDGE for a table session of an outlet its edge serves. Call
 * after the permission check with the caller's scoped context: a session the
 * caller cannot see is left to the route's own 404.
 */
export async function assertTableSessionNotOnEdge(
  context: ScopedTenantContext,
  sessionId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ outletId: tableSessions.outletId })
      .from(tableSessions)
      .where(
        and(
          eq(tableSessions.tenantId, tenantId),
          eq(tableSessions.id, sessionId),
        ),
      )
      .limit(1);
    if (row) await assertPosWriteNotOnEdge(tx, tenantId, row.outletId);
  });
}

/** 409 POS_WRITE_ON_EDGE for an outlet its edge serves (after the permission check). */
export async function assertOutletNotOnEdge(
  context: ScopedTenantContext,
  outletId: OutletId,
): Promise<void> {
  await withTenant(db, context, (tx) =>
    assertPosWriteNotOnEdge(tx, context.tenant.tenantId, outletId),
  );
}

/**
 * 409 POS_WRITE_ON_EDGE for a target a route names by id (no outlet in the
 * path, E3b): `outletId` is the target's outlet read on the server. A target
 * not found or outside the caller's scope is left to the route's own 403/404,
 * so the caller learns nothing of another outlet's edge.
 */
export async function assertTargetOutletNotOnEdge(
  context: ScopedTenantContext,
  outletId: string | null,
): Promise<void> {
  if (outletId === null) return;
  const parsed = outletIdSchema.safeParse(outletId);
  if (!parsed.success || !isOutletInScope(context.outletScope, parsed.data))
    return;
  const tenantId = context.tenant.tenantId;
  await withTenant(db, memberTenantContext(tenantId), (tx) =>
    assertPosWriteNotOnEdge(tx, tenantId, parsed.data),
  );
}
