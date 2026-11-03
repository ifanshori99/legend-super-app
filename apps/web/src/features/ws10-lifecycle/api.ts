// One typed caller per HRIS endpoint these screens read (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./hooks.ts own cache keys and invalidation.
//
// The screens only read through endpoints. The one write — completing,
// blocking, unblocking or waiving a checklist task — has no endpoint yet, so it
// runs against the mock runtime's local store (see ./local-action.ts and
// ./mock.ts) and fails closed in a real session.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import type { CursorPage } from "@starter/shared/core";
import {
  getEmployee,
  listEmployees,
  listOrgUnits,
  listPositions,
  type Employee,
  type OrgUnit,
  type Position,
} from "@starter/shared/hris";
import { callEndpoint } from "@/lib/api/endpoint";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];

export type EmployeeQuery = QueryOf<typeof listEmployees>;

/** One page of the employee directory (the caller follows the cursor). */
export async function fetchEmployeePage(
  query: EmployeeQuery,
  signal?: AbortSignal,
): Promise<CursorPage<Employee>> {
  return callEndpoint(listEmployees, { query }, { signal });
}

/** One employee, unwrapped from the `{ data }` envelope. */
export async function fetchEmployee(
  employeeId: string,
  signal?: AbortSignal,
): Promise<Employee> {
  const response = await callEndpoint(
    getEmployee,
    { params: { employeeId } },
    { signal },
  );
  return response.data;
}

export async function fetchPositionPage(
  signal?: AbortSignal,
): Promise<CursorPage<Position>> {
  return callEndpoint(listPositions, { query: { limit: 100 } }, { signal });
}

export async function fetchOrgUnitPage(
  signal?: AbortSignal,
): Promise<CursorPage<OrgUnit>> {
  return callEndpoint(listOrgUnits, { query: { limit: 100 } }, { signal });
}
