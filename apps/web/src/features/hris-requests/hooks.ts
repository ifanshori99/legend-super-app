// Custom hooks of the HRIS requests feature (539-U4 / legend-ydf2): the only
// way the screens touch its data (docs/frontend.md "Custom hooks"). Employee
// side lists and forms, supervisor queue and decisions. Idempotency keys are
// made here: one per attempt, reused when the same payload is sent again after
// a failure (offline "coba lagi"), so a replay never files two requests.
import { useCallback, useMemo, useRef } from "react";
import { useRouteContext } from "@tanstack/react-router";
import type { AreaAccess } from "@/lib/areas/access";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  EmployeeId,
  Holiday,
  LeaveBalance,
  LeaveRequest,
  LeaveType,
  LeaveTypeId,
  OvertimeRequest,
  ShiftAssignment,
  ShiftAssignmentId,
  ShiftSwapRequest,
  ShiftSwapRequestId,
} from "@starter/shared/hris";
import {
  addBusinessDays,
  businessDateOf,
  type OutletId,
} from "@starter/shared/core";
import { useT } from "@/components/i18n";
import type { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { useTenantContext, useOutletClock } from "@/lib/tenant-context";
import { useHydrated } from "../ws10-attendance-qr/use-hydrated.ts";
import {
  postCancelShiftSwap,
  postDecision,
  postLeaveRequest,
  postPeerResponse,
  postOvertimeRequest,
  postShiftSwap,
} from "./api.ts";
import {
  candidatesQuery,
  holidaysQuery,
  hrisRequestKeys,
  leaveBalancesQuery,
  leaveTypesQuery,
  myHrisQuery,
  myLeavesQuery,
  myOvertimesQuery,
  myShiftsQuery,
  mySwapsQuery,
  queueSourceQuery,
} from "./queries.ts";
import {
  isFinalClientError,
  normalizeRequestQueue,
  pickOutletId,
  planDecision,
  type QueueTranslate,
  type RequestDecision,
  type RequestKind,
  type RequestQueueItem,
  type RequestQueueSource,
  type RequestQueueStatus,
  type SwapCandidate,
} from "./queue.ts";

/** How far ahead the employee's own shifts are read. */
const SHIFTS_AHEAD_DAYS = 60;
/** The queue dates swaps from shifts this far back. */
const QUEUE_SHIFTS_BACK_DAYS = 30;
// ---- Shared pieces --------------------------------------------------------

/** The signed-in employee and outlet (HR-01), once the profile answered. */
export function useMyHris() {
  const hydrated = useHydrated();
  return useQuery({ ...myHrisQuery(), enabled: hydrated });
}

/** Today's business date of the outlet; null until the client is hydrated. */
function useToday(): string | null {
  const hydrated = useHydrated();
  const { clock } = useOutletClock();
  return useMemo(
    () => (hydrated ? businessDateOf(new Date(), clock) : null),
    [hydrated, clock],
  );
}

/**
 * One key per attempt: the same payload keeps its key until a send succeeds
 * (a retry after a network failure is the same request), a changed payload
 * gets a new one.
 */
function useAttemptKey() {
  const ref = useRef<{ fingerprint: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(payload: unknown): string {
        const fingerprint = JSON.stringify(payload);
        if (ref.current?.fingerprint !== fingerprint)
          ref.current = { fingerprint, key: newIdempotencyKey() };
        return ref.current.key;
      },
      reset(): void {
        ref.current = null;
      },
    }),
    [],
  );
}

/**
 * A 4xx answer (409 and the like) is final for that payload: the next attempt
 * gets a new key. Only a network failure or 5xx may reuse the stored key.
 */
function dropKeyOnClientError(
  error: ApiError,
  attempt: { reset(): void },
): void {
  if (isFinalClientError(error.status)) attempt.reset();
}

// ---- Employee: lists ------------------------------------------------------

export function useMyShiftSwaps(): UseQueryResult<ShiftSwapRequest[]> {
  const hydrated = useHydrated();
  return useQuery({ ...mySwapsQuery(), enabled: hydrated });
}

export function useMyLeaveRequests(): UseQueryResult<LeaveRequest[]> {
  const me = useMyHris().data?.employee.id;
  return useQuery({
    ...myLeavesQuery(me as EmployeeId),
    enabled: me !== undefined,
  });
}

export function useMyOvertimeRequests(): UseQueryResult<OvertimeRequest[]> {
  const me = useMyHris().data?.employee.id;
  return useQuery({
    ...myOvertimesQuery(me as EmployeeId),
    enabled: me !== undefined,
  });
}

export function usePeerResponse() {
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  return useMutation({
    mutationFn: (input: {
      swapId: ShiftSwapRequestId;
      action: "accept" | "reject";
      rejectionReason?: string;
    }) =>
      postPeerResponse(
        input.swapId,
        input.action,
        input.rejectionReason,
        attempt.keyFor(input),
      ),
    onSuccess: () => {
      attempt.reset();
      void queryClient.invalidateQueries({ queryKey: hrisRequestKeys.all });
    },
    onError: (error: ApiError) => dropKeyOnClientError(error, attempt),
  });
}

/** Balances of the current year, one row per leave type. */
export function useLeaveBalances(): UseQueryResult<LeaveBalance[]> {
  const me = useMyHris().data?.employee.id;
  const today = useToday();
  const year = Number((today ?? "0000").slice(0, 4));
  return useQuery({
    ...leaveBalancesQuery(me as EmployeeId, year),
    enabled: me !== undefined && today !== null,
  });
}

/** Active leave types. */
export function useLeaveTypes(): UseQueryResult<LeaveType[]> {
  const hydrated = useHydrated();
  return useQuery({ ...leaveTypesQuery(), enabled: hydrated });
}

/** My shifts from today on (the next 60 days), earliest first. */
export function useMyShiftAssignments(): UseQueryResult<ShiftAssignment[]> {
  const me = useMyHris().data?.employee.id;
  const today = useToday();
  const from = today ?? "";
  const to = today === null ? "" : addBusinessDays(today, SHIFTS_AHEAD_DAYS);
  return useQuery({
    ...myShiftsQuery(me as EmployeeId, from, to),
    enabled: me !== undefined && today !== null,
    select: (rows) =>
      rows
        .slice()
        .sort(
          (left, right) =>
            left.businessDate.localeCompare(right.businessDate) ||
            left.id.localeCompare(right.id),
        ),
  });
}

/** Colleagues from the employee-safe candidate endpoint. */
export function useSwapCandidates(
  fromAssignmentId: string | undefined,
): UseQueryResult<SwapCandidate[]> {
  const mine = useMyShiftAssignments().data;
  const from = mine?.find((row) => row.id === fromAssignmentId);
  return useQuery({
    ...candidatesQuery(
      from?.outletId as ShiftAssignment["outletId"],
      fromAssignmentId as ShiftAssignmentId,
    ),
    enabled: from !== undefined,
    select: (data): SwapCandidate[] =>
      data.map((row) => ({
        employeeId: row.id,
        employeeName: row.name,
        assignments: row.assignments,
      })),
  });
}

/** Holidays between two business dates, inclusive. */
export function useHolidays(range: {
  from: string;
  to: string;
}): UseQueryResult<Holiday[]> {
  const hydrated = useHydrated();
  return useQuery({
    ...holidaysQuery(range.from, range.to),
    enabled: hydrated,
  });
}

// ---- Employee: create and cancel -------------------------------------------

export type CreateShiftSwapInput = {
  fromAssignmentId: ShiftAssignmentId;
  toEmployeeId: EmployeeId;
  /** A shift of the colleague for a true swap; null hands the shift over. */
  toAssignmentId: ShiftAssignmentId | null;
  /** The shift's outlet; defaults to the employee's own outlet when empty. */
  outletId?: OutletId;
  /** Optional: a caller that retries sends the same key to prevent a double send. */
  idempotencyKey?: string;
};

export type CreateLeaveRequestInput = {
  leaveTypeId: LeaveTypeId;
  startDate: string;
  endDate: string;
  reason: string | null;
  /** Pre-signed upload reference of the attachment, when the type needs one. */
  attachmentUploadRef?: string | null;
  idempotencyKey?: string;
};

export type CreateOvertimeRequestInput = {
  date: string;
  minutes: number;
  reason: string;
  /** Defaults to the employee's own outlet when empty. */
  outletId?: OutletId;
  idempotencyKey?: string;
};

function useRefreshAfterWrite() {
  const queryClient = useQueryClient();
  return {
    all: () =>
      void queryClient.invalidateQueries({ queryKey: hrisRequestKeys.all }),
  };
}

/** Files a swap or a cover (`toAssignmentId: null`) in the employee's outlet. */
export function useCreateShiftSwap(): UseMutationResult<
  ShiftSwapRequest,
  ApiError,
  CreateShiftSwapInput
> {
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  const refresh = useRefreshAfterWrite();
  return useMutation<ShiftSwapRequest, ApiError, CreateShiftSwapInput>({
    mutationFn: async ({ idempotencyKey, ...input }) => {
      const me = await queryClient.ensureQueryData(myHrisQuery());
      return postShiftSwap(
        { ...input, outletId: pickOutletId(input.outletId, me.outlet.id) },
        idempotencyKey ?? attempt.keyFor(input),
      );
    },
    onSuccess: () => {
      attempt.reset();
      refresh.all();
    },
    onError: (error) => {
      dropKeyOnClientError(error, attempt);
      if (error.status === 409) refresh.all();
    },
  });
}

export function useCreateLeaveRequest(): UseMutationResult<
  LeaveRequest,
  ApiError,
  CreateLeaveRequestInput
> {
  const attempt = useAttemptKey();
  const refresh = useRefreshAfterWrite();
  return useMutation<LeaveRequest, ApiError, CreateLeaveRequestInput>({
    mutationFn: ({ idempotencyKey, ...input }) =>
      postLeaveRequest(
        { ...input, attachmentUploadRef: input.attachmentUploadRef ?? null },
        idempotencyKey ?? attempt.keyFor(input),
      ),
    onSuccess: () => {
      attempt.reset();
      refresh.all();
    },
    onError: (error) => {
      dropKeyOnClientError(error, attempt);
      if (error.status === 409) refresh.all();
    },
  });
}

export function useCreateOvertimeRequest(): UseMutationResult<
  OvertimeRequest,
  ApiError,
  CreateOvertimeRequestInput
> {
  const queryClient = useQueryClient();
  const attempt = useAttemptKey();
  const refresh = useRefreshAfterWrite();
  return useMutation<OvertimeRequest, ApiError, CreateOvertimeRequestInput>({
    mutationFn: async ({ idempotencyKey, ...input }) => {
      const me = await queryClient.ensureQueryData(myHrisQuery());
      return postOvertimeRequest(
        { ...input, outletId: pickOutletId(input.outletId, me.outlet.id) },
        idempotencyKey ?? attempt.keyFor(input),
      );
    },
    onSuccess: () => {
      attempt.reset();
      refresh.all();
    },
    onError: (error) => {
      dropKeyOnClientError(error, attempt);
      if (error.status === 409) refresh.all();
    },
  });
}

/** Cancels my own pending swap or cover. */
export function useCancelShiftSwap(): UseMutationResult<
  ShiftSwapRequest,
  ApiError,
  { swapId: ShiftSwapRequestId; idempotencyKey?: string }
> {
  const attempt = useAttemptKey();
  const refresh = useRefreshAfterWrite();
  return useMutation<
    ShiftSwapRequest,
    ApiError,
    { swapId: ShiftSwapRequestId; idempotencyKey?: string }
  >({
    mutationFn: ({ swapId, idempotencyKey }) =>
      postCancelShiftSwap(swapId, idempotencyKey ?? attempt.keyFor(swapId)),
    onSuccess: () => {
      attempt.reset();
      refresh.all();
    },
    onError: (error) => {
      dropKeyOnClientError(error, attempt);
      if (error.status === 409) refresh.all();
    },
  });
}

// ---- Supervisor: queue and decisions ---------------------------------------

/** Source window and outlet shared by the queue and the detail. */
function useQueueScope() {
  const { outlet } = useTenantContext();
  const context = useRouteContext({ strict: false }) as { access?: AreaAccess };
  const today = useToday();
  return {
    permissions: context.access?.permissions ?? [],
    enabled: today !== null && context.access !== undefined,
    outletId: outlet?.id,
    timeZone: outlet?.timeZone ?? "Asia/Jakarta",
    shiftsFrom:
      today === null ? "" : addBusinessDays(today, -QUEUE_SHIFTS_BACK_DAYS),
    shiftsTo: today === null ? "" : addBusinessDays(today, SHIFTS_AHEAD_DAYS),
  };
}

/** Swaps, covers, leave and overtime of the tenant as one queue, newest first. */
export function useRequestQueue(
  filter: { status?: RequestQueueStatus } = {},
): UseQueryResult<RequestQueueItem[]> {
  const t = useT();
  const scope = useQueueScope();
  const status = filter.status;
  const select = useCallback(
    (source: RequestQueueSource) =>
      normalizeRequestQueue(source, t, { status, timeZone: scope.timeZone }),
    [t, status, scope.timeZone],
  );
  return useQuery({
    ...queueSourceQuery({
      status,
      outletId: scope.outletId,
      shiftsFrom: scope.shiftsFrom,
      shiftsTo: scope.shiftsTo,
      permissions: scope.permissions,
    }),
    enabled: scope.enabled,
    select,
  });
}

const sameFamily = (left: RequestKind, right: RequestKind) =>
  left === right ||
  ((left === "swap" || left === "cover") &&
    (right === "swap" || right === "cover"));

/** One request of the queue by kind and id (any status); undefined if absent. */
export function useRequestDetail(
  kind: RequestKind,
  id: string,
): UseQueryResult<RequestQueueItem | undefined> {
  const t = useT();
  const scope = useQueueScope();
  const select = useCallback(
    (source: RequestQueueSource) =>
      normalizeRequestQueue(source, t, { timeZone: scope.timeZone }).find(
        (item) => item.id === id && sameFamily(item.kind, kind),
      ),
    [t, id, kind, scope.timeZone],
  );
  return useQuery({
    ...queueSourceQuery({
      outletId: scope.outletId,
      shiftsFrom: scope.shiftsFrom,
      shiftsTo: scope.shiftsTo,
      permissions: scope.permissions,
    }),
    enabled: scope.enabled,
    select,
  });
}

export type DecideRequestInput = {
  kind: RequestKind;
  id: string;
  decision: RequestDecision;
  /**
   * Required to approve a swap or cover that has compliance issues (sent as
   * the override reason). Other decisions send no reason: the contract has
   * no field for one.
   */
  reason?: string;
  idempotencyKey?: string;
};

/** The cached request, or one read fresh when the cache has not seen it. */
async function findRequest(
  queryClient: QueryClient,
  t: QueueTranslate,
  input: DecideRequestInput,
  scope: ReturnType<typeof useQueueScope>,
): Promise<RequestQueueItem> {
  const match = (source: RequestQueueSource | undefined) =>
    source === undefined
      ? undefined
      : normalizeRequestQueue(source, t, { timeZone: scope.timeZone }).find(
          (item) => item.id === input.id && sameFamily(item.kind, input.kind),
        );
  for (const [, source] of queryClient.getQueriesData<RequestQueueSource>({
    queryKey: hrisRequestKeys.queueAll(),
  })) {
    const found = match(source);
    if (found !== undefined) return found;
  }
  const fresh = await queryClient.fetchQuery(
    queueSourceQuery({
      outletId: scope.outletId,
      shiftsFrom: scope.shiftsFrom,
      shiftsTo: scope.shiftsTo,
      permissions: scope.permissions,
    }),
  );
  const found = match(fresh);
  if (found === undefined) throw new Error("Request not found in the queue.");
  return found;
}

/**
 * Approves or rejects one request. A swap with compliance issues is approved
 * as `approve_with_override` and needs `reason`; without it the call fails
 * with `OverrideReasonRequiredError` before any request is sent.
 */
export function useDecideRequest(): UseMutationResult<
  unknown,
  ApiError,
  DecideRequestInput
> {
  const queryClient = useQueryClient();
  const t = useT();
  const scope = useQueueScope();
  const attempt = useAttemptKey();
  return useMutation<unknown, ApiError, DecideRequestInput>({
    mutationFn: async (input) => {
      const item = await findRequest(queryClient, t, input, scope);
      const plan = planDecision(item, input.decision, input.reason);
      const { idempotencyKey, ...payload } = input;
      return postDecision(
        item,
        plan,
        idempotencyKey ?? attempt.keyFor(payload),
      );
    },
    onSuccess: () => {
      attempt.reset();
      void queryClient.invalidateQueries({ queryKey: hrisRequestKeys.all });
    },
    onError: (error) => {
      dropKeyOnClientError(error, attempt);
      // 409: the request moved on (decided elsewhere, cancelled): show it as is.
      if (error.status === 409)
        void queryClient.invalidateQueries({ queryKey: hrisRequestKeys.all });
    },
  });
}
