// Reuse the durable KDS ticket rows after their creating transaction commits.
// A fixed job key closes the queue/marker crash window without another queue.
import { and, asc, eq, gt, gte, inArray, isNull } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { db } from "../../db/index.ts";
import { withTenant } from "../../db/tenant.ts";
import { kitchenTickets, stations } from "../../db/schema/index.ts";
import {
  appendStationFeed,
  ticketDetails,
} from "../../services/kds-support.ts";
import type { KdsFallbackWindowReader, StationTicketRouter } from "./agent.ts";

export function createKdsPrintFallback(options: {
  db: typeof db;
  context: ScopedTenantContext;
  outletId: OutletId;
}): (
  route: StationTicketRouter,
  getWindow: KdsFallbackWindowReader,
) => Promise<void> {
  const { db: database, context, outletId } = options;
  assertTrustedScopedContext(context);
  assertOutletInScope(context.outletScope, outletId);
  if (
    context.outletScope.kind !== "outlets" ||
    context.outletScope.outletIds.length !== 1
  )
    throw new Error("KDS print fallback requires exactly one edge outlet");
  const eligible = and(
    eq(kitchenTickets.tenantId, context.tenant.tenantId),
    eq(kitchenTickets.outletId, outletId),
    eq(kitchenTickets.printedFallback, false),
    inArray(kitchenTickets.status, ["new", "in_progress", "recalled"]),
    eq(stations.tenantId, context.tenant.tenantId),
    eq(stations.outletId, outletId),
    eq(stations.isActive, true),
    eq(stations.autoPrintFallback, true),
    isNull(stations.deletedAt),
  );
  return async (route, getWindow) => {
    const eligibleWindow = (stationId: string, firedAt: Date) => {
      const window = getWindow(stationId);
      const firedAtMs = firedAt.getTime();
      if (
        window &&
        firedAtMs > window.lastHeartbeatAt.getTime() &&
        firedAtMs >= window.oldestTicketAt.getTime()
      )
        return window;
      return null;
    };
    // No global limit: a healthy station's old tickets must not hide a down
    // station's later tickets. Read metadata without locking, then only lock
    // recent tickets that arrived after a known, now-missing heartbeat.
    const pending = await withTenant(database, context, (tx) =>
      tx
        .select({
          id: kitchenTickets.id,
          stationId: kitchenTickets.stationId,
          firedAt: kitchenTickets.firedAt,
        })
        .from(kitchenTickets)
        .innerJoin(stations, eq(stations.id, kitchenTickets.stationId))
        .where(eligible)
        .orderBy(asc(kitchenTickets.firedAt), asc(kitchenTickets.id)),
    );
    for (const { id, stationId, firedAt } of pending) {
      const window = eligibleWindow(stationId, firedAt);
      if (!window) continue;
      try {
        await withTenant(database, context, async (tx) => {
          const [row] = await tx
            .select({ ticket: kitchenTickets, stationName: stations.name })
            .from(kitchenTickets)
            .innerJoin(stations, eq(stations.id, kitchenTickets.stationId))
            .where(
              and(
                eligible,
                eq(kitchenTickets.id, id),
                gt(kitchenTickets.firedAt, window.lastHeartbeatAt),
                gte(kitchenTickets.firedAt, window.oldestTicketAt),
              ),
            )
            .for("update", { of: kitchenTickets, skipLocked: true });
          if (!row || !eligibleWindow(row.ticket.stationId, row.ticket.firedAt))
            return;
          const [detail] = await ticketDetails(tx, context, [row.ticket]);
          if (!detail) return;
          const items = detail.items
            .filter(
              (item) => item.status !== "voided" && item.status !== "served",
            )
            .map((item) => ({
              name: item.name,
              qty: item.quantity,
              modifiers: item.modifiers,
              note: item.note,
            }));
          // The screen may have resumed while details were loading. Empty
          // tickets carry no cooking work and must never be queued or marked.
          if (
            items.length === 0 ||
            !eligibleWindow(row.ticket.stationId, row.ticket.firedAt)
          )
            return;
          const result = await route({
            stationId: row.ticket.stationId,
            sourceRef: row.ticket.id,
            idempotencyKey: `kds-fallback:${row.ticket.id}`,
            ticket: {
              stationName: row.stationName,
              ticketNumber: `K-${String(row.ticket.ticketNo).padStart(3, "0")}`,
              orderLabel: detail.tableLabel ?? `#${row.ticket.ticketNo}`,
              orderType: detail.channel,
              createdAt: row.ticket.firedAt,
              items,
            },
          });
          if (!result.printed) return;
          await tx
            .update(kitchenTickets)
            .set({ printedFallback: true, updatedAt: new Date() })
            .where(
              and(
                eq(kitchenTickets.tenantId, context.tenant.tenantId),
                eq(kitchenTickets.outletId, outletId),
                eq(kitchenTickets.id, id),
              ),
            );
          await appendStationFeed(tx, context, {
            outletId,
            stationId: row.ticket.stationId,
            ticketId: id,
            now: new Date(),
          });
        });
      } catch {
        // Missing/offline printer or a transient DB error is retried next tick.
        // A failed station must not prevent the remaining backlog from routing.
      }
    }
  };
}
