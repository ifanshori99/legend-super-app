// Query keys and options for the roster screens. `endpointQueryOptions` keys
// by endpoint id + input, so invalidating `[endpoint.id]` refreshes every page
// of that list (docs/frontend.md).
import type { OutletId } from "@starter/shared/core";
import {
  listEmployees,
  listHolidays,
  listPositions,
  listShiftAssignments,
} from "@starter/shared/hris";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { weekEnd } from "./lib";

/** Everything under one prefix, for a screen that opens another roster week. */
export const rosterKeys = { all: ["roster"] as const };

const LIST_LIMIT = 100;

export const employeesQuery = (outletId: OutletId) =>
  endpointQueryOptions(listEmployees, {
    query: {
      outletId,
      status: "active" as const,
      limit: LIST_LIMIT,
    },
  });

export const positionsQuery = () =>
  endpointQueryOptions(listPositions, { query: { limit: LIST_LIMIT } });

export const weekShiftsQuery = (outletId: OutletId, weekStart: string) =>
  endpointQueryOptions(listShiftAssignments, {
    query: {
      outletId,
      from: weekStart,
      to: weekEnd(weekStart),
      limit: LIST_LIMIT,
    },
  });

/** National/collective holidays for the week's year (PRD §3 29 "Hari Libur"). */
export const holidaysQuery = (weekStart: string) =>
  endpointQueryOptions(listHolidays, {
    query: {
      year: Number(weekStart.slice(0, 4)),
      limit: LIST_LIMIT,
    },
  });
