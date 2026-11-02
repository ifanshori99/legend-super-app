import {
  listKitchenStations,
  getKitchenBoard,
  startKitchenTicket,
  bumpKitchenTicket,
  recallKitchenTicket,
  setKitchenTicketPriority,
  updateKitchenTicketItem,
} from "@starter/shared/kitchen";
import type {
  StationConfig,
  KitchenTicketDetail,
  KitchenTicketItem,
  KitchenItemAction,
} from "@starter/shared/kitchen";
import { callEndpoint } from "@/lib/api/endpoint.ts";
import { KITCHEN_OUTLET_ID } from "../ws04-expo/outlet.ts";

export async function fetchStations(signal?: AbortSignal) {
  return (
    await callEndpoint(
      listKitchenStations,
      { params: { outletId: KITCHEN_OUTLET_ID } },
      { signal },
    )
  ).data;
}
export async function fetchBoard(
  stationId: StationConfig["stationId"],
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      getKitchenBoard,
      { params: { outletId: KITCHEN_OUTLET_ID, stationId } },
      { signal },
    )
  ).data;
}
export async function ticketAction(
  ticketId: KitchenTicketDetail["id"],
  action: "start" | "bump" | "recall",
  reason?: string,
) {
  const params = { outletId: KITCHEN_OUTLET_ID, ticketId };
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
  ticketId: KitchenTicketDetail["id"],
  priority: number,
) {
  return (
    await callEndpoint(setKitchenTicketPriority, {
      params: { outletId: KITCHEN_OUTLET_ID, ticketId },
      body: { priority },
    })
  ).data;
}
export async function updateItem(
  itemId: KitchenTicketItem["id"],
  action: KitchenItemAction,
) {
  return (
    await callEndpoint(updateKitchenTicketItem, {
      params: { outletId: KITCHEN_OUTLET_ID, itemId },
      body: { action },
    })
  ).data;
}

/** Station names and target times belong to the menu contract. */
export async function fetchMenuStations(signal?: AbortSignal) {
  const { listStations } = await import("@starter/shared/menu");
  const rows: import("@starter/shared/menu").Station[] = [];
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(
      listStations,
      { query: { outletId: KITCHEN_OUTLET_ID, limit: 100, cursor } },
      { signal },
    );
    rows.push(...page.data);
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** F12 86: find the outlet's availability record before issuing its action. */
export async function markUnavailable(menuItemId: string) {
  const { listAvailability, setAvailabilityStatus } =
    await import("@starter/shared/menu");
  let cursor: string | undefined;
  do {
    const page = await callEndpoint(listAvailability, {
      query: { outletId: KITCHEN_OUTLET_ID, limit: 100, cursor },
    });
    const row = page.data.find((entry) => entry.menuItemId === menuItemId);
    if (row) {
      if (row.status === "sold_out") return row;
      return (
        await callEndpoint(setAvailabilityStatus, {
          params: { availabilityId: row.id },
          body: { action: "sell_out", idempotencyKey: crypto.randomUUID() },
        })
      ).data;
    }
    cursor = page.meta.nextCursor ?? undefined;
  } while (cursor);
  throw new Error("Availability record not found");
}
