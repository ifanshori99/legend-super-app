// Query keys and options for the equipment registry, service schedules,
// breakdown tickets and shift handover. Keys are `[endpoint.id, input]`
// (docs/frontend.md), so invalidating `[endpoint.id]` refreshes every view.
import { queryOptions } from "@tanstack/react-query";
import { listSuppliers } from "@starter/shared/inventory";
import { listItems } from "@starter/shared/menu";
import {
  getEquipment,
  getShiftHandover,
  listEquipment,
  listMaintenanceSchedules,
  listMaintenanceTickets,
  listShiftHandovers,
} from "@starter/shared/operations";
import { endpointQueryOptions } from "@/lib/api/endpoint";

/** One page is enough for the outlet's registry, schedules, tickets and
 * handovers (cursor pages are capped at 100 by the contract). */
export const LIST_LIMIT = 100;

export const equipmentListQuery = (outletId: string) =>
  endpointQueryOptions(listEquipment, {
    query: { outletId, limit: LIST_LIMIT },
  });

export const equipmentQuery = (equipmentId: string) =>
  endpointQueryOptions(getEquipment, { params: { equipmentId } });

export const schedulesQuery = (outletId: string) =>
  endpointQueryOptions(listMaintenanceSchedules, {
    query: { outletId, limit: LIST_LIMIT },
  });

export const ticketsQuery = (outletId: string) =>
  endpointQueryOptions(listMaintenanceTickets, {
    query: { outletId, limit: LIST_LIMIT },
  });

export const handoversQuery = (outletId: string) =>
  endpointQueryOptions(listShiftHandovers, {
    query: { outletId, limit: LIST_LIMIT },
  });

export const handoverQuery = (handoverId: string) =>
  endpointQueryOptions(getShiftHandover, { params: { handoverId } });

/** Vendor names for schedules and tickets (WS-06 purchasing suppliers). */
export const serviceVendorsQuery = () =>
  endpointQueryOptions(listSuppliers, {
    query: { limit: LIST_LIMIT, isActive: "true" },
  });

/** Menu names for the OPS-04 linked-menu view (WS-03 menu contract). */
export const menuItemsQuery = () =>
  queryOptions({
    ...endpointQueryOptions(listItems, { query: { limit: LIST_LIMIT } }),
    // The mapping is a read-only name lookup; a stale page is harmless.
    staleTime: 60_000,
  });
