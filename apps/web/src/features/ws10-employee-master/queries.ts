// Query keys and options for the employee master back office.
// `endpointQueryOptions` keys by endpoint id + input, so invalidating
// `[endpoint.id]` refreshes every page of that list (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import {
  getEmployee,
  getEmployeePii,
  listEmployeeDocuments,
  listEmployees,
  listEmploymentContracts,
  listOrgUnits,
  listPositionGrades,
  listPositions,
} from "@starter/shared/hris";
import { orgEndpoints } from "@starter/shared/platform";
import {
  callEndpoint,
  endpointQueryOptions,
  type CallArgs,
} from "@/lib/api/endpoint";
import { collectAllPages, LIST_LIMIT, type AnyPage } from "./lib";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type ListEndpoint = AnyEndpoint & { method: "GET" };

/**
 * queryOptions for a cursor list the screens filter in memory: follows
 * `meta.nextCursor` to the last page, so a catalog over one page is never
 * silently truncated. Keyed under the endpoint id, so
 * `invalidateQueries({ queryKey: [endpoint.id] })` still refreshes it.
 */
export function allPagesQuery<E extends ListEndpoint>(
  endpoint: E,
  input: EndpointInput<E>,
) {
  return queryOptions({
    queryKey: [endpoint.id, "all-pages", input] as const,
    queryFn: ({ signal }) =>
      collectAllPages<AnyPage>(async (cursor) => {
        const withCursor = {
          ...(input as Record<string, unknown>),
          query: {
            ...((input as { query?: Record<string, unknown> }).query ?? {}),
            cursor,
          },
        } as EndpointInput<E>;
        const page = await callEndpoint(
          endpoint,
          ...([withCursor, { signal }] as unknown as CallArgs<E>),
        );
        return page as unknown as AnyPage;
      }) as unknown as Promise<EndpointOutput<E>>,
  });
}

/** Everything under one prefix, for a screen that opens a different area. */
export const employeeMasterKeys = { all: ["employeeMaster"] as const };

export const employeesQuery = (
  query: Query<typeof listEmployees> = { limit: LIST_LIMIT },
) => allPagesQuery(listEmployees, { query });

export const employeeQuery = (employeeId: string) =>
  endpointQueryOptions(getEmployee, { params: { employeeId } });

/** HR-03: masked PII only, and only for a caller allowed to read it. */
export const employeePiiQuery = (employeeId: string) =>
  endpointQueryOptions(getEmployeePii, { params: { employeeId } });

export const orgUnitsQuery = () =>
  allPagesQuery(listOrgUnits, { query: { limit: LIST_LIMIT } });

export const positionGradesQuery = () =>
  allPagesQuery(listPositionGrades, { query: { limit: LIST_LIMIT } });

export const positionsQuery = () =>
  allPagesQuery(listPositions, { query: { limit: LIST_LIMIT } });

export const contractsQuery = (
  query: Query<typeof listEmploymentContracts> = { limit: LIST_LIMIT },
) => allPagesQuery(listEmploymentContracts, { query });

export const documentsQuery = (employeeId: string) =>
  allPagesQuery(listEmployeeDocuments, {
    params: { employeeId },
    query: { limit: LIST_LIMIT },
  });

export const outletsQuery = () =>
  allPagesQuery(orgEndpoints.listOutlets, { query: { limit: LIST_LIMIT } });
