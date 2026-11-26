import {
  listKitchenStationLabels,
  listKitchenStationTickets,
  listKitchenStations,
  getKitchenBoard,
  getKitchenStationSummary,
  startKitchenTicket,
  bumpKitchenTicket,
  recallKitchenTicket,
  setKitchenTicketPriority,
  updateKitchenTicketItem,
  recordKitchenStationHeartbeat,
  getKitchenTicketPrint,
} from "@starter/shared/kitchen";
import type {
  StationConfig,
  KitchenTicketDetail,
  KitchenTicketItem,
  KitchenItemAction,
} from "@starter/shared/kitchen";
import type { PrintPaperWidth } from "@starter/shared/pos";
import { callEndpoint } from "@/lib/api/endpoint.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import { getKdsScannerStatus } from "./contract-gap.ts";

export async function sendKdsHeartbeat(
  outletId: string,
  stationId: StationConfig["stationId"],
  signal?: AbortSignal,
) {
  return callEndpoint(
    recordKitchenStationHeartbeat,
    { params: { outletId, stationId }, body: {} },
    { signal },
  );
}

export async function fetchStations(outletId: string, signal?: AbortSignal) {
  return (
    await callEndpoint(
      listKitchenStations,
      { params: { outletId } },
      { signal },
    )
  ).data;
}
export async function fetchBoard(
  outletId: string,
  stationId: StationConfig["stationId"],
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      getKitchenBoard,
      { params: { outletId, stationId } },
      { signal },
    )
  ).data;
}
/** Open tickets plus the realtime cursor (`sequence`) they are current to. */
export async function fetchStationSnapshot(
  outletId: string,
  stationId: StationConfig["stationId"],
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      listKitchenStationTickets,
      { params: { outletId, stationId } },
      { signal },
    )
  ).data;
}
export async function fetchStationSummary(
  outletId: string,
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      getKitchenStationSummary,
      { params: { outletId } },
      { signal },
    )
  ).data;
}
export async function ticketAction(
  outletId: string,
  ticketId: KitchenTicketDetail["id"],
  action: "start" | "bump" | "recall",
  reason?: string,
) {
  const params = { outletId, ticketId };
  if (action === "start")
    return (await callEndpoint(startKitchenTicket, { params })).data;
  if (action === "bump")
    return (await callEndpoint(bumpKitchenTicket, { params })).data;
  return (
    await callEndpoint(recallKitchenTicket, {
      params,
      body: { reason: reason ?? "" },
    })
  ).data;
}
export async function setPriority(
  outletId: string,
  ticketId: KitchenTicketDetail["id"],
  priority: number,
) {
  return (
    await callEndpoint(setKitchenTicketPriority, {
      params: { outletId, ticketId },
      body: { priority },
    })
  ).data;
}
export async function updateItem(
  outletId: string,
  itemId: KitchenTicketItem["id"],
  action: KitchenItemAction,
) {
  return (
    await callEndpoint(updateKitchenTicketItem, {
      params: { outletId, itemId },
      body: { action },
    })
  ).data;
}

/**
 * Station names and target times for the KDS (legend-gt7f): the KDS read the
 * cook is allowed (`kds.ticket.process`), not the menu station list.
 */
export async function fetchStationLabels(
  outletId: string,
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      listKitchenStationLabels,
      { params: { outletId } },
      { signal },
    )
  ).data;
}

/** F12 86: find the outlet's availability record before issuing its action. */
export async function markUnavailable(outletId: string, menuItemId: string) {
  const { listAvailability, setAvailabilityStatus } =
    await import("@starter/shared/menu");
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(listAvailability, {
      query: { outletId, limit: 100, cursor },
    });
    const row = page.data.find((entry) => entry.menuItemId === menuItemId);
    if (row) {
      if (row.status === "sold_out") return row;
      return (
        await callEndpoint(setAvailabilityStatus, {
          params: { availabilityId: row.id },
          body: { action: "sell_out", idempotencyKey: newIdempotencyKey() },
        })
      ).data;
    }
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor);
  throw new Error("Availability record not found");
}

/** Scanner connection (contract gap, see contract-gap.ts). */
export async function fetchScannerStatus(
  outletId: string,
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      getKdsScannerStatus,
      { params: { outletId } },
      { signal },
    )
  ).data;
}

/** P3: the ticket as ESC/POS bytes for this tablet's own printer. */
export async function fetchTicketPrint(
  outletId: string,
  ticketId: KitchenTicketDetail["id"],
  paperWidth: PrintPaperWidth,
  reprint: boolean,
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      getKitchenTicketPrint,
      { params: { outletId, ticketId }, query: { paperWidth, reprint: reprint ? "true" : "false" } },
      { signal },
    )
  ).data;
}
