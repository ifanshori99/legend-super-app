// Query keys and options of the HRIS requests feature (539-U4 / legend-ydf2).
// Everything sits under "hris-requests" so one invalidation after a write
// refreshes every list. Not prefetched during SSR: the data is the caller's
// own or behind the supervisor right, so hooks fetch after hydration.
import { queryOptions } from "@tanstack/react-query";
import type { EmployeeId } from "@starter/shared/hris";
import type { OutletId } from "@starter/shared/core";
import {
  fetchEmployees,
  fetchHolidays,
  fetchLeaveBalances,
  fetchLeaveRequests,
  fetchLeaveTypes,
  fetchMyHris,
  fetchOvertimeRequests,
  fetchQueueSource,
  fetchShifts,
  fetchSwaps,
} from "./api.ts";
import type { RequestQueueStatus } from "./queue.ts";

export const hrisRequestKeys = {
  all: ["hris-requests"] as const,
  me: () => [...hrisRequestKeys.all, "me"] as const,
  swaps: () => [...hrisRequestKeys.all, "my-swaps"] as const,
  leaves: (employeeId: string) =>
    [...hrisRequestKeys.all, "my-leaves", employeeId] as const,
  overtimes: (employeeId: string) =>
    [...hrisRequestKeys.all, "my-overtimes", employeeId] as const,
  balances: (employeeId: string, year: number) =>
    [...hrisRequestKeys.all, "balances", employeeId, year] as const,
  leaveTypes: () => [...hrisRequestKeys.all, "leave-types"] as const,
  myShifts: (employeeId: string, from: string, to: string) =>
    [...hrisRequestKeys.all, "my-shifts", employeeId, from, to] as const,
  candidates: (outletId: string, from: string, to: string) =>
    [...hrisRequestKeys.all, "candidates", outletId, from, to] as const,
  holidays: (from: string, to: string) =>
    [...hrisRequestKeys.all, "holidays", from, to] as const,
  queueAll: () => [...hrisRequestKeys.all, "queue"] as const,
  queue: (
    status: RequestQueueStatus | undefined,
    outletId: string | undefined,
    from: string,
    to: string,
  ) =>
    [
      ...hrisRequestKeys.queueAll(),
      status ?? "all",
      outletId ?? "none",
      from,
      to,
    ] as const,
};

const STALE = 15_000;

export function myHrisQuery() {
  return queryOptions({
    queryKey: hrisRequestKeys.me(),
    queryFn: ({ signal }) => fetchMyHris(signal),
    staleTime: 5 * 60_000,
  });
}

export function mySwapsQuery() {
  return queryOptions({
    queryKey: hrisRequestKeys.swaps(),
    queryFn: ({ signal }) => fetchSwaps({ mine: true }, signal),
    staleTime: STALE,
  });
}

export function myLeavesQuery(employeeId: EmployeeId) {
  return queryOptions({
    queryKey: hrisRequestKeys.leaves(employeeId),
    queryFn: ({ signal }) => fetchLeaveRequests({ employeeId }, signal),
    staleTime: STALE,
  });
}

export function myOvertimesQuery(employeeId: EmployeeId) {
  return queryOptions({
    queryKey: hrisRequestKeys.overtimes(employeeId),
    queryFn: ({ signal }) => fetchOvertimeRequests({ employeeId }, signal),
    staleTime: STALE,
  });
}

export function leaveBalancesQuery(employeeId: EmployeeId, year: number) {
  return queryOptions({
    queryKey: hrisRequestKeys.balances(employeeId, year),
    queryFn: ({ signal }) => fetchLeaveBalances(employeeId, year, signal),
    staleTime: STALE,
  });
}

export function leaveTypesQuery() {
  return queryOptions({
    queryKey: hrisRequestKeys.leaveTypes(),
    queryFn: async ({ signal }) =>
      (await fetchLeaveTypes(signal)).filter((type) => type.isActive),
    staleTime: 5 * 60_000,
  });
}

export function myShiftsQuery(
  employeeId: EmployeeId,
  from: string,
  to: string,
) {
  return queryOptions({
    queryKey: hrisRequestKeys.myShifts(employeeId, from, to),
    queryFn: ({ signal }) => fetchShifts({ employeeId, from, to }, signal),
    staleTime: STALE,
  });
}

/** Colleagues and the outlet's shifts in the window (raw; hooks shape them). */
export function candidatesQuery(outletId: OutletId, from: string, to: string) {
  return queryOptions({
    queryKey: hrisRequestKeys.candidates(outletId, from, to),
    queryFn: async ({ signal }) => {
      const [employees, assignments] = await Promise.all([
        fetchEmployees({ outletId, active: true }, signal),
        fetchShifts({ outletId, from, to }, signal),
      ]);
      return { employees, assignments };
    },
    staleTime: STALE,
  });
}

export function holidaysQuery(from: string, to: string) {
  return queryOptions({
    queryKey: hrisRequestKeys.holidays(from, to),
    queryFn: ({ signal }) => fetchHolidays({ from, to }, signal),
    staleTime: 5 * 60_000,
  });
}

/** The raw queue sources; hooks normalise them with the catalog in `select`. */
export function queueSourceQuery(input: {
  status?: RequestQueueStatus;
  outletId?: OutletId;
  shiftsFrom: string;
  shiftsTo: string;
}) {
  return queryOptions({
    queryKey: hrisRequestKeys.queue(
      input.status,
      input.outletId,
      input.shiftsFrom,
      input.shiftsTo,
    ),
    queryFn: ({ signal }) => fetchQueueSource(input, signal),
    staleTime: STALE,
  });
}
