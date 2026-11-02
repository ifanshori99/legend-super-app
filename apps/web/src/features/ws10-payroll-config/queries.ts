// Query keys and options for the payroll configuration screen. Every key
// starts with the endpoint id (`endpointQueryOptions`), so one
// `invalidateQueries({ queryKey: [endpoint.id] })` refreshes every cached page
// of that endpoint (docs/frontend.md).
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { listEmployees } from "@starter/shared/hris";
import {
  listEmployeePayComponents,
  listPayComponents,
  listPayrollPolicies,
  listStatutoryTables,
  listThrSchedules,
} from "@starter/shared/hris/payroll";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** Configuration lists are tenant config, not a growing log: one page. */
export const PAYROLL_PAGE_SIZE = 100;

export const statutoryTablesQuery = (query: Query<typeof listStatutoryTables>) =>
  endpointQueryOptions(listStatutoryTables, { query });

export const payrollPoliciesQuery = (query: Query<typeof listPayrollPolicies>) =>
  endpointQueryOptions(listPayrollPolicies, { query });

export const payComponentsQuery = (query: Query<typeof listPayComponents>) =>
  endpointQueryOptions(listPayComponents, { query });

export const thrSchedulesQuery = (query: Query<typeof listThrSchedules>) =>
  endpointQueryOptions(listThrSchedules, { query });

export const employeePayComponentsQuery = (
  employeeId: string,
  query: Query<typeof listEmployeePayComponents> = { limit: PAYROLL_PAGE_SIZE },
) =>
  endpointQueryOptions(listEmployeePayComponents, {
    params: { employeeId },
    query,
  });

/** Active employees for the pickers (read model owned by the HRIS mock). */
export const activeEmployeesQuery = () =>
  endpointQueryOptions(listEmployees, {
    query: { limit: PAYROLL_PAGE_SIZE, status: "active" },
  });

const page = { limit: PAYROLL_PAGE_SIZE };

export const statutoryTablesDefaultQuery = () => statutoryTablesQuery(page);
export const payrollPoliciesDefaultQuery = () => payrollPoliciesQuery(page);
export const payComponentsDefaultQuery = () => payComponentsQuery(page);
export const thrSchedulesDefaultQuery = () => thrSchedulesQuery(page);
