// Query keys and options for the WS-10 lifecycle screens. Every option is keyed
// by the endpoint id + input, so invalidating `[listChecklistTasks.id]`
// refreshes every employee's checklist (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import type { CursorPage } from "@starter/shared/core";
import {
  getEmployee,
  getOffboardingSettlement,
  listChecklistTasks,
  listEmployees,
  listOrgUnits,
  listPositions,
  type ChecklistKind,
  type Employee,
  type OrgUnit,
  type Position,
} from "@starter/shared/hris";
import {
  listEmployeePayComponents,
  listPayComponents,
  listReimbursements,
  listStatutoryTables,
} from "@starter/shared/hris/payroll";
import { endpointQueryKey, endpointQueryOptions } from "@/lib/api/endpoint";
import {
  fetchEmployee,
  fetchEmployeePage,
  fetchOrgUnitPage,
  fetchPositionPage,
  type EmployeeQuery,
} from "./api.ts";
import { collectAllPages } from "./pages.ts";

/** Everything under one prefix, for a screen that leaves for another area. */
export const lifecycleKeys = { all: ["lifecycle"] as const };

/**
 * A cursor list the screens filter in memory: follows `meta.nextCursor` to the
 * last page, so the directory is never silently truncated at PAGE_LIMIT_MAX.
 * Keyed under the endpoint id, so `invalidateQueries({ queryKey: [id] })`
 * still refreshes it.
 */
function allPagesQuery<T>(input: {
  key: readonly unknown[];
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>;
}) {
  return queryOptions({
    queryKey: input.key,
    queryFn: () =>
      collectAllPages<T, CursorPage<T>>((cursor) => input.fetchPage(cursor)),
  });
}

/** The whole employee directory; each screen filters the statuses it owns. */
export function employeesQuery(query: EmployeeQuery) {
  return allPagesQuery<Employee>({
    key: [...endpointQueryKey(listEmployees, { query }), "all-pages"],
    fetchPage: (cursor) =>
      fetchEmployeePage(cursor === undefined ? query : { ...query, cursor }),
  });
}

export function positionsQuery() {
  return allPagesQuery<Position>({
    key: [...endpointQueryKey(listPositions, { query: { limit: 100 } }), "all"],
    fetchPage: () => fetchPositionPage(),
  });
}

export function orgUnitsQuery() {
  return allPagesQuery<OrgUnit>({
    key: [...endpointQueryKey(listOrgUnits, { query: { limit: 100 } }), "all"],
    fetchPage: () => fetchOrgUnitPage(),
  });
}

export function employeeQuery(employeeId: string) {
  return queryOptions({
    queryKey: endpointQueryKey(getEmployee, { params: { employeeId } }),
    queryFn: ({ signal }) => fetchEmployee(employeeId, signal),
  });
}

/**
 * One employee's checklist of one kind. The contract lists tasks per employee
 * only — a tenant-wide task list is still missing (follow-up bead) — so the
 * list screens ask each candidate employee for its tasks in parallel.
 */
export function checklistTasksQuery(
  employeeId: string,
  kind: ChecklistKind,
  limit = 100,
) {
  return endpointQueryOptions(listChecklistTasks, {
    params: { employeeId },
    query: { kind, limit },
  });
}

// ---- Final settlement reads (payroll contract, HR-03 salary data) ---------
//
// Every read below is salary data: the screen only enables them for a viewer
// holding payroll.view, and the API re-checks the permission.

/** The employee's pay components (amounts per period, salary data). */
export function employeePayComponentsQuery(employeeId: string) {
  return endpointQueryOptions(listEmployeePayComponents, {
    params: { employeeId },
    query: { limit: 100 },
  });
}

/** The tenant's pay component catalog (which components count toward THR). */
export function payComponentsQuery() {
  return endpointQueryOptions(listPayComponents, { query: { limit: 100 } });
}

/** The versioned THR tables; the contract resolves the one in force. */
export function thrTablesQuery() {
  return endpointQueryOptions(listStatutoryTables, {
    query: { type: "thr", limit: 100 },
  });
}

/**
 * The server's own final-settlement summary: kasbon owed (already net of the
 * installments a payroll run reserved) and those pending deductions. The
 * client shows these numbers as they are and never recomputes them.
 */
export function finalSettlementQuery(offboardingId: string) {
  return endpointQueryOptions(getOffboardingSettlement, {
    params: { offboardingId },
  });
}

export function employeeReimbursementsQuery(employeeId: string) {
  return endpointQueryOptions(listReimbursements, {
    query: { employeeId, limit: 100 },
  });
}
