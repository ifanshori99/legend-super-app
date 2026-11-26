import { and, eq, isNull } from "drizzle-orm";
import type { KitchenTicketDetail } from "@starter/shared/kitchen";
import type { PrintPaperWidth, PrintPayload } from "@starter/shared/pos";
import {
  assertOutletInScope,
  CoreError,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db/index.ts";
import { stations } from "../db/schema/menu.ts";
import { withTenant } from "../db/tenant.ts";
import { getEdgePrintAgent } from "../edge/print/runtime.ts";
import { renderStationTicket } from "../edge/print/templates.ts";
import { getEdgeRuntimeState } from "../edge/runtime.ts";
import { toPrintPayload } from "./pos-receipt-edge-print.ts";
import { assertStationPermission } from "./station-access.ts";

/** Only an external heartbeat reports liveness; server-side KDS reads do not. */
export async function recordKitchenStationHeartbeat(
  context: ScopedTenantContext,
  actorUserId: string,
  rawOutletId: string,
  stationId: string,
): Promise<{ recorded: boolean }> {
  const outletId = outletIdSchema.parse(rawOutletId);
  assertOutletInScope(context.outletScope, outletId);
  await withTenant(db, context, async (tx) => {
    await assertStationPermission(
      tx,
      context,
      actorUserId,
      "kds.ticket.process",
      stationId,
      new Date(),
    );
    const [station] = await tx
      .select({ id: stations.id })
      .from(stations)
      .where(
        and(
          eq(stations.tenantId, context.tenant.tenantId),
          eq(stations.outletId, outletId),
          eq(stations.id, stationId),
          isNull(stations.deletedAt),
        ),
      );
    if (!station)
      throw new CoreError("NOT_FOUND", "Stasiun dapur tidak ditemukan.");
  });
  const runtime = getEdgeRuntimeState();
  const agent = getEdgePrintAgent();
  if (
    !runtime.edgeMode ||
    !agent ||
    runtime.identity?.context.tenant.tenantId !== context.tenant.tenantId ||
    runtime.identity.scope.outletId !== outletId
  )
    return { recorded: false };
  agent.recordKdsHeartbeat(stationId);
  return { recorded: true };
}

/**
 * P1: a station ticket as ESC/POS bytes for the KDS tablet's own printer. Same
 * lines the edge fallback prints (voided and served lines stay off). A ticket
 * with no line left to cook has nothing to print.
 */
export function stationTicketPayload(
  ticket: KitchenTicketDetail,
  stationName: string,
  paperWidth: PrintPaperWidth,
): PrintPayload {
  const items = ticket.items
    .filter((item) => item.status !== "voided" && item.status !== "served")
    .map((item) => ({
      name: item.name,
      qty: item.quantity,
      modifiers: item.modifiers,
      note: item.note,
    }));
  if (items.length === 0)
    throw new CoreError(
      "CONFLICT",
      "Tiket ini tidak punya baris untuk dicetak.",
    );
  return toPrintPayload(
    renderStationTicket(
      {
        stationName,
        ticketNumber: `K-${String(ticket.ticketNo).padStart(3, "0")}`,
        orderLabel: ticket.tableLabel ?? `#${ticket.ticketNo}`,
        orderType: ticket.channel,
        createdAt: new Date(ticket.firedAt),
        items,
      },
      paperWidth,
    ),
    paperWidth,
    false,
  );
}
