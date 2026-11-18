// The only way the lifecycle screens touch data: queries keep their endpoint
// keys, the task action invalidates the checklist list after it writes.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  listChecklistTasks,
  transitionChecklistTask,
  type ChecklistAction,
  type ChecklistKind,
  type ChecklistTask,
} from "@starter/shared/hris";
import { ApiError } from "@/lib/api/errors";
import { runLocalTaskAction } from "./local-action.ts";
import {
  checklistTasksQuery,
  employeePayComponentsQuery,
  employeeQuery,
  employeeReimbursementsQuery,
  finalSettlementQuery,
  payComponentsQuery,
  thrTablesQuery,
  employeesQuery,
  orgUnitsQuery,
  positionsQuery,
} from "./queries.ts";
import { LIST_LIMIT } from "./lib.ts";

// ---- Queries -------------------------------------------------------------

/** The whole employee directory (every page), for the two list screens. */
export function useEmployeeDirectory() {
  return useQuery(employeesQuery({ limit: LIST_LIMIT }));
}

export function useEmployee(employeeId: string) {
  return useQuery({
    ...employeeQuery(employeeId),
    enabled: employeeId !== "",
  });
}

export function usePositions() {
  return useQuery(positionsQuery());
}

export function useOrgUnits() {
  return useQuery(orgUnitsQuery());
}

/** One employee's checklist of one kind (detail screens). */
export function useChecklistTasks(employeeId: string, kind: ChecklistKind) {
  return useQuery({
    ...checklistTasksQuery(employeeId, kind),
    enabled: employeeId !== "",
  });
}

export type ChecklistTasksByEmployee = {
  /** Employee id → its tasks (empty when the employee has none). */
  tasks: ReadonlyMap<string, ChecklistTask[]>;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
};

/**
 * The checklist of every candidate employee.
 *
 * The contract lists checklist tasks per employee only — there is no
 * tenant-wide task list yet (follow-up bead) — so a list screen that must know
 * "who still has an open task" asks each candidate in parallel, bounded by the
 * directory page size. Each answer is cached per employee id, so revisiting the
 * screen costs nothing.
 */
export function useChecklistTasksForEmployees(
  employeeIds: readonly string[],
  kind: ChecklistKind,
): ChecklistTasksByEmployee {
  const queries = useQueries({
    queries: employeeIds.map((employeeId) => ({
      ...checklistTasksQuery(employeeId, kind),
      enabled: employeeId !== "",
    })),
  });
  const tasks = new Map<string, ChecklistTask[]>();
  employeeIds.forEach((employeeId, index) => {
    const page = queries[index]?.data;
    tasks.set(employeeId, page ? [...page.data] : []);
  });
  return {
    tasks,
    isPending: queries.some((query) => query.isPending),
    isError: queries.some((query) => query.isError),
    refetch: () => {
      for (const query of queries) void query.refetch();
    },
  };
}

/**
 * The payroll reads behind the final-settlement estimate. `enabled` is the
 * caller's payroll.view check: a viewer without it never requests salary data
 * (HR-03), and the API refuses it anyway.
 */
export function useSettlementSources(employeeId: string, enabled: boolean) {
  const on = enabled && employeeId !== "";
  const rows = useQuery({
    ...employeePayComponentsQuery(employeeId),
    enabled: on,
  });
  const components = useQuery({ ...payComponentsQuery(), enabled: on });
  const tables = useQuery({ ...thrTablesQuery(), enabled: on });
  const claims = useQuery({
    ...employeeReimbursementsQuery(employeeId),
    enabled: on,
  });
  const all = [rows, components, tables, claims];
  return {
    rows: rows.data?.data ?? [],
    components: components.data?.data ?? [],
    tables: tables.data?.data ?? [],
    claims: claims.data?.data ?? [],
    isPending: all.some((query) => query.isPending),
    isError: all.some((query) => query.isError),
    refetch: () => {
      for (const query of all) if (query.isError) void query.refetch();
    },
  };
}

/**
 * The API's final-settlement summary of one offboarding (kasbon owed and the
 * payroll deductions already pending). Never requested without payroll.view
 * (`enabled`) or before the offboarding id is known.
 */
export function useFinalSettlement(
  offboardingId: string | null,
  enabled: boolean,
) {
  return useQuery({
    ...finalSettlementQuery(offboardingId ?? ""),
    enabled: enabled && offboardingId !== null,
  });
}

// ---- Mutations -----------------------------------------------------------

export type ChecklistTaskActionInput = {
  task: ChecklistTask;
  action: ChecklistAction;
};

/**
 * Complete / block / unblock / waive one task.
 *
 * The contract's `transitionChecklistTask` decides the next status (an illegal
 * move throws CONFLICT exactly as the API would); the mock runtime's local
 * store applies it, because no task-action endpoint exists yet. In a real
 * session there is no writer, so the action fails closed with 501 instead of
 * showing a state the server never accepted.
 */
export function useChecklistTaskAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      task,
      action,
    }: ChecklistTaskActionInput): Promise<ChecklistTask> => {
      transitionChecklistTask(task.status, action);
      const updated = runLocalTaskAction({ taskId: task.id, action });
      if (updated === null)
        throw new ApiError(
          501,
          "NOT_IMPLEMENTED",
          "Aksi checklist belum punya endpoint.",
        );
      return updated;
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listChecklistTasks.id] }),
  });
}
