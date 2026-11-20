// The only way components touch employee-master data: queries keep their
// endpoint keys, mutations invalidate the endpoints whose rows a write changes.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  changeEmployeeManagerEndpoint,
  correctEmployeePtkpEndpoint,
  getEmployee,
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
  employeeMasterKeys,
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

type ManagerWrite = {
  params: ParamsOf<typeof changeEmployeeManagerEndpoint>;
  body: BodyOf<typeof changeEmployeeManagerEndpoint>;
};

/**
 * Ubah atasan: the manager name on the profile and the directory's "Belum ada
 * atasan" warning both derive from `managerId`, so the detail, every list page
 * and the employee-master prefix are refreshed together.
 */
export function useChangeEmployeeManager() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ params, body }: ManagerWrite) =>
      api.saveEmployeeManager(params, body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [getEmployee.id] }),
        queryClient.invalidateQueries({ queryKey: [listEmployees.id] }),
        queryClient.invalidateQueries({ queryKey: employeeMasterKeys.all }),
      ]),
  });
}

type PtkpWrite = {
  params: ParamsOf<typeof correctEmployeePtkpEndpoint>;
  body: BodyOf<typeof correctEmployeePtkpEndpoint>;
};

/**
 * Koreksi status PTKP (bead 1223): the profile shows the latest status, so
 * the detail and the lists refresh. The dialog reads the tax-year status and
 * the next status from the mutation result.
 */
export function useCorrectEmployeePtkp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ params, body }: PtkpWrite) =>
      api.saveEmployeePtkp(params, body),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [getEmployee.id] }),
        queryClient.invalidateQueries({ queryKey: [listEmployees.id] }),
        queryClient.invalidateQueries({ queryKey: employeeMasterKeys.all }),
      ]),
  });
}
