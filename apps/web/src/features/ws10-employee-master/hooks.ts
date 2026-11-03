// The only way components touch employee-master data: queries keep their
// endpoint keys, mutations invalidate the endpoints whose rows a write changes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getEmployeePii,
  listEmployees,
  listEmploymentContracts,
  updateEmployeePii,
} from "@starter/shared/hris";
import * as api from "./api";
import {
  contractsQuery,
  documentsQuery,
  employeePiiQuery,
  employeeQuery,
  employeesQuery,
  orgUnitsQuery,
  outletsQuery,
  positionGradesQuery,
  positionsQuery,
} from "./queries";

type QueryOf<E extends AnyEndpoint> = EndpointInput<E>["query"];
type ParamsOf<E extends AnyEndpoint> = EndpointInput<E>["params"];
type BodyOf<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Queries -------------------------------------------------------------

export function useEmployees(query?: QueryOf<typeof listEmployees>) {
  return useQuery(employeesQuery(query));
}

export function useEmployee(employeeId: string | undefined) {
  return useQuery({
    ...employeeQuery(employeeId ?? ""),
    enabled: Boolean(employeeId),
  });
}

/**
 * Masked PII (HR-03). `enabled` is false for a visitor without
 * `hr.employee.view`: the profile shows its locked state instead of asking the
 * API for data it must refuse.
 */
export function useEmployeePii(employeeId: string | undefined, enabled = true) {
  return useQuery({
    ...employeePiiQuery(employeeId ?? ""),
    enabled: Boolean(employeeId) && enabled,
  });
}

export function useOrgUnits() {
  return useQuery(orgUnitsQuery());
}

export function usePositionGrades() {
  return useQuery(positionGradesQuery());
}

export function usePositions() {
  return useQuery(positionsQuery());
}

export function useContracts(query?: QueryOf<typeof listEmploymentContracts>) {
  return useQuery(contractsQuery(query));
}

export function useDocuments(employeeId: string | undefined) {
  return useQuery({
    ...documentsQuery(employeeId ?? ""),
    enabled: Boolean(employeeId),
  });
}

export function useOutlets() {
  return useQuery(outletsQuery());
}

// ---- Mutations -----------------------------------------------------------

type PiiWrite = {
  params: ParamsOf<typeof updateEmployeePii>;
  body: BodyOf<typeof updateEmployeePii>;
};

/**
 * HR-03: the write answers with the new masked values, so the panel refetches
 * the guarded endpoint instead of trusting a client-side copy of PII.
 */
export function useUpdateEmployeePii() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ params, body }: PiiWrite) =>
      api.saveEmployeePii(params, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [getEmployeePii.id] }),
  });
}
