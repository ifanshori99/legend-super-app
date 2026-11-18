// Edge node alert state (beads legend-uux9k, legend-uvnll, legend-ph62j;
// docs/design/edge-status-cloud.md D5). One OPEN alert per node and kind; it
// closes when its condition clears, so a later episode is a new row.
//
// Callers pass the tenant, outlet and node ids taken from the edge credential
// or the verified session, never from a request body. No database singleton:
// the edge link applier calls these inside its own transaction (kept apart
// from edge-sync-conflict.service.ts for the same reason as
// edge-sync-conflict-alert.ts).
import { and, eq, isNull, lt, lte, sql } from "drizzle-orm";
import { createUlid, type OutletId, type TenantId } from "@starter/shared/core";
import type { EdgeNodeAlertKind } from "@starter/shared/edge/node-status";
import { edgeNodeAlerts } from "../db/schema/edge-node-alert.ts";
import type { EdgeTx } from "./edge-queue.service.ts";

export type EdgeNodeAlertDetail = Record<string, string | number | null>;

export interface RaiseEdgeNodeAlertInput {
  tenantId: TenantId;
  outletId: OutletId;
  edgeNodeId: string;
  kind: EdgeNodeAlertKind;
  at: Date;
  /** Counts and times only: no device ids, no secrets. */
  detail: EdgeNodeAlertDetail;
  /** Edge event (ULID) that opened the alert; omit for cloud-computed alerts. */
  sourceEventId?: string;
}

/**
 * Opens an alert, or confirms the open one (`last_seen_at` only moves
 * forward, `detail` is replaced). `opened` is true only for a new row.
 */
export async function raiseEdgeNodeAlert(
  tx: EdgeTx,
  input: RaiseEdgeNodeAlertInput,
): Promise<{ opened: boolean }> {
  const rows = await tx
    .insert(edgeNodeAlerts)
    .values({
      id: createUlid(),
      tenantId: input.tenantId,
      outletId: input.outletId,
      edgeNodeId: input.edgeNodeId,
      kind: input.kind,
      raisedAt: input.at,
      lastSeenAt: input.at,
      detail: input.detail,
      sourceEventId: input.sourceEventId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        edgeNodeAlerts.tenantId,
        edgeNodeAlerts.edgeNodeId,
        edgeNodeAlerts.kind,
      ],
      targetWhere: isNull(edgeNodeAlerts.resolvedAt),
      set: {
        lastSeenAt: sql`GREATEST(${edgeNodeAlerts.lastSeenAt}, excluded.last_seen_at)`,
        detail: sql`excluded.detail`,
        updatedAt: sql`now()`,
      },
    })
    // xmax is 0 only on a fresh insert; an upsert update stamps it.
    .returning({ opened: sql<boolean>`(xmax = 0)` });
  return { opened: rows[0]?.opened === true };
}

export interface ResolveEdgeNodeAlertsInput {
  tenantId: TenantId;
  edgeNodeId: string;
  kind: EdgeNodeAlertKind;
  at: Date;
  /** Resolve only a row last confirmed at or before this time. */
  quietSince?: Date;
  /** Resolve only an episode opened before this recovery heartbeat. */
  raisedBefore?: Date;
}

/**
 * Closes the open alert of a node and kind. `resolved_at` is never before
 * `raised_at`. Returns the number of rows closed (0 when none was open).
 */
export async function resolveEdgeNodeAlerts(
  tx: EdgeTx,
  input: ResolveEdgeNodeAlertsInput,
): Promise<number> {
  const rows = await tx
    .update(edgeNodeAlerts)
    .set({
      resolvedAt: sql`GREATEST(${input.at.toISOString()}::timestamptz, ${edgeNodeAlerts.raisedAt})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(edgeNodeAlerts.tenantId, input.tenantId),
        eq(edgeNodeAlerts.edgeNodeId, input.edgeNodeId),
        eq(edgeNodeAlerts.kind, input.kind),
        isNull(edgeNodeAlerts.resolvedAt),
        input.quietSince
          ? lte(edgeNodeAlerts.lastSeenAt, input.quietSince)
          : undefined,
        input.raisedBefore
          ? lt(edgeNodeAlerts.raisedAt, input.raisedBefore)
          : undefined,
      ),
    )
    .returning({ id: edgeNodeAlerts.id });
  return rows.length;
}
