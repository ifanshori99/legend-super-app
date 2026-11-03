// One typed caller per payroll-configuration endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Components never call these directly: they use
// the hooks in ./hooks.ts, which own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  archiveStatutoryTable as archiveStatutoryTableEndpoint,
  createPayComponent as createPayComponentEndpoint,
  createPayrollPolicy as createPayrollPolicyEndpoint,
  createStatutoryTableDraft as createStatutoryTableDraftEndpoint,
  createThrSchedule as createThrScheduleEndpoint,
  getStatutoryTable as getStatutoryTableEndpoint,
  listEmployeePayComponents as listEmployeePayComponentsEndpoint,
  listPayComponents as listPayComponentsEndpoint,
  listPayrollPolicies as listPayrollPoliciesEndpoint,
  listStatutoryTables as listStatutoryTablesEndpoint,
  listThrSchedules as listThrSchedulesEndpoint,
  publishStatutoryTable as publishStatutoryTableEndpoint,
  setEmployeePayComponent as setEmployeePayComponentEndpoint,
  updatePayComponent as updatePayComponentEndpoint,
  updatePayrollPolicy as updatePayrollPolicyEndpoint,
  updateStatutoryTableDraft as updateStatutoryTableDraftEndpoint,
} from "@starter/shared/hris/payroll";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Statutory tables -----------------------------------------------------

export type StatutoryListQuery = Query<typeof listStatutoryTablesEndpoint>;
export type StatutoryDraftBody = Body<typeof createStatutoryTableDraftEndpoint>;
export type StatutoryVersionParams = Params<typeof getStatutoryTableEndpoint>;

export const fetchStatutoryTables = (query: StatutoryListQuery) =>
  callEndpoint(listStatutoryTablesEndpoint, { query });

export const fetchStatutoryVersion = (params: StatutoryVersionParams) =>
  callEndpoint(getStatutoryTableEndpoint, { params });

export const createStatutoryDraft = (body: StatutoryDraftBody) =>
  callEndpoint(createStatutoryTableDraftEndpoint, { body });

export const updateStatutoryDraft = (
  params: StatutoryVersionParams,
  body: Body<typeof updateStatutoryTableDraftEndpoint>,
) => callEndpoint(updateStatutoryTableDraftEndpoint, { params, body });

export const publishStatutoryVersion = (
  params: StatutoryVersionParams,
  body: Body<typeof publishStatutoryTableEndpoint>,
) => callEndpoint(publishStatutoryTableEndpoint, { params, body });

export const archiveStatutoryVersion = (
  params: StatutoryVersionParams,
  body: Body<typeof archiveStatutoryTableEndpoint>,
) => callEndpoint(archiveStatutoryTableEndpoint, { params, body });

// ---- Policies -------------------------------------------------------------

export type PolicyListQuery = Query<typeof listPayrollPoliciesEndpoint>;
export type PolicyCreateInput = Body<typeof createPayrollPolicyEndpoint>;
export type PolicyUpdatePatch = Body<typeof updatePayrollPolicyEndpoint>;
export type PolicyParams = Params<typeof updatePayrollPolicyEndpoint>;

export const fetchPayrollPolicies = (query: PolicyListQuery) =>
  callEndpoint(listPayrollPoliciesEndpoint, { query });

export const createPayrollPolicy = (body: PolicyCreateInput) =>
  callEndpoint(createPayrollPolicyEndpoint, { body });

export const updatePayrollPolicy = (
  params: PolicyParams,
  body: PolicyUpdatePatch,
) => callEndpoint(updatePayrollPolicyEndpoint, { params, body });

// ---- Components -----------------------------------------------------------

export type ComponentListQuery = Query<typeof listPayComponentsEndpoint>;
export type ComponentCreateInput = Body<typeof createPayComponentEndpoint>;
export type ComponentUpdatePatch = Body<typeof updatePayComponentEndpoint>;
export type ComponentParams = Params<typeof updatePayComponentEndpoint>;

export const fetchPayComponents = (query: ComponentListQuery) =>
  callEndpoint(listPayComponentsEndpoint, { query });

export const createPayComponent = (body: ComponentCreateInput) =>
  callEndpoint(createPayComponentEndpoint, { body });

export const updatePayComponent = (
  params: ComponentParams,
  body: ComponentUpdatePatch,
) => callEndpoint(updatePayComponentEndpoint, { params, body });

// ---- Employee pay components (salary, HR-03) -----------------------------

export type EmployeePayComponentQuery = Query<
  typeof listEmployeePayComponentsEndpoint
>;
export type EmployeePayComponentParams = Params<
  typeof listEmployeePayComponentsEndpoint
>;
export type SetEmployeePayComponentInput = Body<
  typeof setEmployeePayComponentEndpoint
>;

export const fetchEmployeePayComponents = (
  params: EmployeePayComponentParams,
  query: EmployeePayComponentQuery,
) => callEndpoint(listEmployeePayComponentsEndpoint, { params, query });

export const setEmployeePayComponent = (
  params: EmployeePayComponentParams,
  body: SetEmployeePayComponentInput,
) => callEndpoint(setEmployeePayComponentEndpoint, { params, body });

// ---- THR schedules --------------------------------------------------------

export type ThrListQuery = Query<typeof listThrSchedulesEndpoint>;
export type ThrCreateInput = Body<typeof createThrScheduleEndpoint>;

export const fetchThrSchedules = (query: ThrListQuery) =>
  callEndpoint(listThrSchedulesEndpoint, { query });

export const createThrSchedule = (body: ThrCreateInput) =>
  callEndpoint(createThrScheduleEndpoint, { body });
