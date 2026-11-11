// The only way components touch payroll-configuration data: queries keep their
// endpoint keys; every write invalidates the lists it changes (docs/frontend.md
// "Custom hooks").
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getStatutoryTable,
  listEmployeePayComponents,
  listPayComponents,
  listPayrollPolicies,
  listStatutoryTables,
  listThrSchedules,
} from "@starter/shared/hris/payroll";
import * as api from "./api";
import {
  activeEmployeesQuery,
  employeePayComponentsQuery,
  payComponentsDefaultQuery,
  payrollLegalEntitiesQuery,
  payrollPoliciesDefaultQuery,
  statutoryTablesDefaultQuery,
  thrSchedulesDefaultQuery,
} from "./queries";

function useInvalidate() {
  const queryClient = useQueryClient();
  return (endpoints: readonly AnyEndpoint[]) =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

function usePayrollMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  invalidate: readonly AnyEndpoint[],
) {
  const refresh = useInvalidate();
  return useMutation({
    mutationFn,
    onSuccess: () => refresh(invalidate),
  });
}

// ---- Reads -----------------------------------------------------------------

export function useStatutoryTables() {
  return useQuery(statutoryTablesDefaultQuery());
}

export function usePayrollPolicies() {
  return useQuery(payrollPoliciesDefaultQuery());
}

export function usePayComponents() {
  return useQuery(payComponentsDefaultQuery());
}

export function useThrSchedules() {
  return useQuery(thrSchedulesDefaultQuery());
}

export function usePayrollLegalEntities() {
  return useQuery(payrollLegalEntitiesQuery());
}

export function useActiveEmployees() {
  return useQuery(activeEmployeesQuery());
}

/** Salary rows of one employee; the query is skipped until one is chosen. */
export function useEmployeePayComponents(employeeId: string | null) {
  const query = useQuery({
    ...employeePayComponentsQuery(employeeId ?? ""),
    enabled: employeeId !== null,
  });
  return query;
}

// ---- Statutory writes -----------------------------------------------------

export function useCreateStatutoryDraft() {
  return usePayrollMutation(api.createStatutoryDraft, [
    listStatutoryTables,
    getStatutoryTable,
  ]);
}

export function useUpdateStatutoryDraft() {
  return usePayrollMutation(
    (variables: {
      params: Parameters<typeof api.updateStatutoryDraft>[0];
      body: Parameters<typeof api.updateStatutoryDraft>[1];
    }) => api.updateStatutoryDraft(variables.params, variables.body),
    [listStatutoryTables, getStatutoryTable],
  );
}

export function usePublishStatutory() {
  return usePayrollMutation(
    (variables: {
      params: Parameters<typeof api.publishStatutoryVersion>[0];
      body: Parameters<typeof api.publishStatutoryVersion>[1];
    }) => api.publishStatutoryVersion(variables.params, variables.body),
    [listStatutoryTables, getStatutoryTable],
  );
}

export function useArchiveStatutory() {
  return usePayrollMutation(
    (variables: {
      params: Parameters<typeof api.archiveStatutoryVersion>[0];
      body: Parameters<typeof api.archiveStatutoryVersion>[1];
    }) => api.archiveStatutoryVersion(variables.params, variables.body),
    [listStatutoryTables, getStatutoryTable],
  );
}

// ---- Policy writes --------------------------------------------------------

export function useCreatePayrollPolicy() {
  return usePayrollMutation(api.createPayrollPolicy, [listPayrollPolicies]);
}

export function useUpdatePayrollPolicy() {
  return usePayrollMutation(
    (variables: {
      params: Parameters<typeof api.updatePayrollPolicy>[0];
      body: Parameters<typeof api.updatePayrollPolicy>[1];
    }) => api.updatePayrollPolicy(variables.params, variables.body),
    [listPayrollPolicies],
  );
}

// ---- Component writes -----------------------------------------------------

export function useCreatePayComponent() {
  return usePayrollMutation(api.createPayComponent, [
    listPayComponents,
    listEmployeePayComponents,
  ]);
}

export function useUpdatePayComponent() {
  return usePayrollMutation(
    (variables: {
      params: Parameters<typeof api.updatePayComponent>[0];
      body: Parameters<typeof api.updatePayComponent>[1];
    }) => api.updatePayComponent(variables.params, variables.body),
    [listPayComponents, listEmployeePayComponents],
  );
}

export function useSetEmployeePayComponent() {
  return usePayrollMutation(
    (variables: {
      params: Parameters<typeof api.setEmployeePayComponent>[0];
      body: Parameters<typeof api.setEmployeePayComponent>[1];
    }) => api.setEmployeePayComponent(variables.params, variables.body),
    [listEmployeePayComponents],
  );
}

// ---- THR writes -----------------------------------------------------------

export function useCreateThrSchedule() {
  return usePayrollMutation(api.createThrSchedule, [listThrSchedules]);
}
