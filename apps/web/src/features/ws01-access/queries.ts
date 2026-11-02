// Query keys and options for the RBAC admin screens. `endpointQueryOptions`
// keys by endpoint id + input, so invalidating `[endpoint.id]` refreshes every
// page of that list (docs/frontend.md).
import { endpointQueryOptions } from "@/lib/api/endpoint";
import {
  getApprovalMatrix,
  listMfaFactors,
  listRoleAssignments,
  listRoles,
} from "@starter/shared/identity";
import { orgEndpoints } from "@starter/shared/platform";
import { listStations } from "@starter/shared/menu";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const accessKeys = {
  all: ["access"] as const,
};

export const rolesQuery = () => endpointQueryOptions(listRoles);

export const assignmentsQuery = (query: Query<typeof listRoleAssignments>) =>
  endpointQueryOptions(listRoleAssignments, { query });

export const approvalMatrixQuery = () =>
  endpointQueryOptions(getApprovalMatrix);

export const mfaFactorsQuery = () => endpointQueryOptions(listMfaFactors);

export const brandsQuery = () => endpointQueryOptions(orgEndpoints.listBrands);

export const outletsQuery = (query: Query<typeof orgEndpoints.listOutlets>) =>
  endpointQueryOptions(orgEndpoints.listOutlets, { query });

export const stationsQuery = (query: Query<typeof listStations>) =>
  endpointQueryOptions(listStations, { query });
