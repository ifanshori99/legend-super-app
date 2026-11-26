// Back-office "Status edge" list (beads legend-ph62j, legend-eo3lc;
// docs/design/edge-status-cloud.md section 3). Active edge nodes the caller
// may see, with link state, open alerts and the outlet's open failover window
// (1271 F4). Read-only; pattern of
// listEdgeSyncConflicts.
//
// Never selects credential, instance, cursor, registration or revoke columns:
// the DTO is built from an explicit column list.
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  outletIdSchema,
  toIsoDateTime,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EdgeNodeFailoverStatus } from "@starter/shared/edge";
import type {
  EdgeNodeStatus,
  EdgeNodeStatusAlert,
  EdgeNodeStatusList,
  EdgeNodeStatusQuery,
} from "@starter/shared/edge/node-status";
import { db } from "../db/index.ts";
import { outletFailoverWindows } from "../db/schema/edge-failover.ts";
import { edgeNodeAlerts } from "../db/schema/edge-node-alert.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { isHeartbeatFresh } from "../edge/link-freshness.ts";

const NODE_LIMIT = 500;
/** The column default for a node that has not reported a version yet. */
const UNKNOWN_VERSION = "unknown";

export async function listEdgeNodeStatus(
  context: ScopedTenantContext,
  query: EdgeNodeStatusQuery,
  now: Date = new Date(),
): Promise<EdgeNodeStatusList> {
  assertTrustedScopedContext(context);
  const outletId = query.outletId
    ? outletIdSchema.parse(query.outletId)
    : undefined;
  if (outletId) assertOutletInScope(context.outletScope, outletId);
  const tenantId = context.tenant.tenantId;
  const conditions = [
    eq(edgeNodes.tenantId, tenantId),
    eq(edgeNodes.status, "active"),
    outletId ? eq(edgeNodes.outletId, outletId) : undefined,
    // A caller reaching only some outlets never sees the others (RLS also
    // enforces it; this keeps the intent explicit).
    context.outletScope.kind === "outlets"
      ? inArray(edgeNodes.outletId, [...context.outletScope.outletIds])
      : undefined,
  ];
  return withTenant(db, context, async (tx) => {
    // Fetch one extra row to know whether the list was cut.
    const rows = await tx
      .select({
        id: edgeNodes.id,
        label: edgeNodes.label,
        role: edgeNodes.role,
        version: edgeNodes.version,
        lastHeartbeatAt: edgeNodes.lastHeartbeatAt,
        outletId: edgeNodes.outletId,
        outletName: outlets.name,
      })
      .from(edgeNodes)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, edgeNodes.tenantId),
          eq(outlets.id, edgeNodes.outletId),
        ),
      )
      .where(and(...conditions))
      // 'primary' sorts before 'standby'.
      .orderBy(
        asc(outlets.name),
        asc(edgeNodes.role),
        asc(edgeNodes.label),
        asc(edgeNodes.id),
      )
      .limit(NODE_LIMIT + 1);
    const page = rows.slice(0, NODE_LIMIT);

    const alertsByNode = new Map<string, EdgeNodeStatusAlert[]>();
    if (page.length > 0) {
      const open = await tx
        .select({
          edgeNodeId: edgeNodeAlerts.edgeNodeId,
          kind: edgeNodeAlerts.kind,
          raisedAt: edgeNodeAlerts.raisedAt,
          lastSeenAt: edgeNodeAlerts.lastSeenAt,
        })
        .from(edgeNodeAlerts)
        .where(
          and(
            eq(edgeNodeAlerts.tenantId, tenantId),
            isNull(edgeNodeAlerts.resolvedAt),
            inArray(
              edgeNodeAlerts.edgeNodeId,
              page.map((row) => row.id),
            ),
          ),
        )
        .orderBy(asc(edgeNodeAlerts.kind));
      for (const alert of open) {
        const list = alertsByNode.get(alert.edgeNodeId) ?? [];
        list.push({
          kind: alert.kind,
          raisedAt: toIsoDateTime(alert.raisedAt),
          lastSeenAt: toIsoDateTime(alert.lastSeenAt),
        });
        alertsByNode.set(alert.edgeNodeId, list);
      }
    }

    // 1271 F4: the outlet's open failover window (at most one per outlet).
    const failoverByOutlet = new Map<string, EdgeNodeFailoverStatus>();
    if (page.length > 0) {
      const windows = await tx
        .select({
          outletId: outletFailoverWindows.outletId,
          windowId: outletFailoverWindows.id,
          status: outletFailoverWindows.status,
          activatedAt: outletFailoverWindows.activatedAt,
        })
        .from(outletFailoverWindows)
        .where(
          and(
            eq(outletFailoverWindows.tenantId, tenantId),
            inArray(outletFailoverWindows.status, ["active", "returning"]),
            inArray(outletFailoverWindows.outletId, [
              ...new Set(page.map((row) => row.outletId)),
            ]),
          ),
        );
      for (const window of windows)
        failoverByOutlet.set(window.outletId, {
          windowId: window.windowId,
          status: window.status,
          activatedAt: toIsoDateTime(window.activatedAt),
        });
    }

    const data: EdgeNodeStatus[] = page.map((row) => ({
      id: row.id,
      label: row.label,
      role: row.role,
      outlet: { id: row.outletId, name: row.outletName },
      version: row.version === UNKNOWN_VERSION ? null : row.version,
      link: isHeartbeatFresh(row.lastHeartbeatAt, now)
        ? "connected"
        : "disconnected",
      lastHeartbeatAt: row.lastHeartbeatAt
        ? toIsoDateTime(row.lastHeartbeatAt)
        : null,
      alerts: alertsByNode.get(row.id) ?? [],
      failover: failoverByOutlet.get(row.outletId) ?? null,
    }));
    return {
      data,
      meta: {
        generatedAt: toIsoDateTime(now),
        truncated: rows.length > NODE_LIMIT,
      },
    };
  });
}
