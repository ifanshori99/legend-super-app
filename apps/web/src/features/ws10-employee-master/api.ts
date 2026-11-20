// One typed caller per HRIS endpoint this back office uses (docs/frontend.md
// "Typed endpoints and mock mode"). Components never call these directly: the
// hooks in ./hooks.ts own cache keys and invalidation.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  changeEmployeeManagerEndpoint,
  correctEmployeePtkpEndpoint,
  getEmployee,
  getEmployeePii,
  listEmployeeDocuments,
  listEmployees,
  listEmploymentContracts,
  listOrgUnits,
  listPositionGrades,
  listPositions,
  updateEmployeePii as updateEmployeePiiEndpoint,
} from "@starter/shared/hris";
import { orgEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];
type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Reads ---------------------------------------------------------------

export const fetchEmployees = (query: Query<typeof listEmployees>) =>
  callEndpoint(listEmployees, { query });

export const fetchEmployee = (params: Params<typeof getEmployee>) =>
  callEndpoint(getEmployee, { params });

/** HR-03: the only route that returns (masked) employee PII. */
export const fetchEmployeePii = (params: Params<typeof getEmployeePii>) =>
  callEndpoint(getEmployeePii, { params });

export const fetchOrgUnits = (query: Query<typeof listOrgUnits>) =>
  callEndpoint(listOrgUnits, { query });

export const fetchPositionGrades = (query: Query<typeof listPositionGrades>) =>
  callEndpoint(listPositionGrades, { query });

export const fetchPositions = (query: Query<typeof listPositions>) =>
  callEndpoint(listPositions, { query });

export const fetchContracts = (query: Query<typeof listEmploymentContracts>) =>
  callEndpoint(listEmploymentContracts, { query });

export const fetchDocuments = (
  params: Params<typeof listEmployeeDocuments>,
  query: Query<typeof listEmployeeDocuments>,
) => callEndpoint(listEmployeeDocuments, { params, query });

/** Outlet names for the home-outlet column (the organisation contract owns them). */
export const fetchOutlets = (query: Query<typeof orgEndpoints.listOutlets>) =>
  callEndpoint(orgEndpoints.listOutlets, { query });

// ---- Writes --------------------------------------------------------------

/**
 * HR-03: the body carries the new values only; the API encrypts them and
 * answers with the masked form, so a raw value never comes back.
 */
export const saveEmployeePii = (
  params: Params<typeof updateEmployeePiiEndpoint>,
  body: Body<typeof updateEmployeePiiEndpoint>,
) => callEndpoint(updateEmployeePiiEndpoint, { params, body });

/** Ubah atasan: sets or clears `managerId`; answers with the updated employee. */
export const saveEmployeeManager = (
  params: Params<typeof changeEmployeeManagerEndpoint>,
  body: Body<typeof changeEmployeeManagerEndpoint>,
) => callEndpoint(changeEmployeeManagerEndpoint, { params, body });

/** Koreksi status PTKP (bead 1223): status, day in force and reason. */
export const saveEmployeePtkp = (
  params: Params<typeof correctEmployeePtkpEndpoint>,
  body: Body<typeof correctEmployeePtkpEndpoint>,
) => callEndpoint(correctEmployeePtkpEndpoint, { params, body });
