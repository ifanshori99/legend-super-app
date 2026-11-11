// The only data door for the cashier ordering and captain screens
// (docs/frontend.md): components import hooks from here and never touch
// apiFetch, useQuery or mock data. List hooks return the TanStack query result,
// so the list is `.data`. Mutations update the cache, so a screen rerenders
// from the hook result alone. Outside mock mode a call without a contract fails
// with an ApiError whose code is CONTRACT_PENDING (see `isContractPending`).
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { useCloudConnection } from "@/features/ws02-edge/hooks";
import { useHydrated } from "@/features/ws02-edge/use-now";
import {
  acknowledgeCall,
  addToTable,
  fireLines,
  fireTableLines,
  parkDraft,
  resolveCall,
  resumeDraft,
  submitOrder,
} from "./api";
import { orderDemoSeed, readDemoSeed } from "./demo-seed";
import {
  callNumberQuery,
  captainTablesQuery,
  catalogQuery,
  parkedDraftsQuery,
  posOrderKeys,
  serviceCallsQuery,
  tableOrderQuery,
} from "./queries";
import {
  CONTRACT_PENDING,
  type AddToTableInput,
  type CaptainTable,
  type Catalog,
  type FireLinesInput,
  type FireTableLinesInput,
  type OrderingConnectivity,
  type ParkDraftInput,
  type ParkedDraft,
  type PosOrderView,
  type ServiceCall,
  type SubmitOrderInput,
  type TableOrderView,
} from "./types";

export { useDraftCart } from "./draft-store";

/** True when the server has no contract for the call yet (show "belum tersambung"). */
export function isContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/** Mock mode needs no outlet; real calls do. */
function useReady(): boolean {
  const outletId = useOutletId();
  return API_MOCK || outletId !== "";
}

/**
 * One idempotency key per intent. The same input keeps the same key until the
 * call succeeds (`clear`), so a retry after a timeout or a double tap is
 * recognised by the server; a changed input is a new intent and a new key.
 */
function useIntentKey(prefix: string) {
  const current = useRef<{ fingerprint: string; key: string } | null>(null);
  return {
    keyFor(input: unknown): string {
      const fingerprint = JSON.stringify(input);
      if (current.current?.fingerprint !== fingerprint)
        current.current = {
          fingerprint,
          key: `${prefix}:${globalThis.crypto.randomUUID()}`,
        };
      return current.current.key;
    },
    clear() {
      current.current = null;
    },
  };
}

// ---- Cashier ---------------------------------------------------------------

export function usePosCatalog(): UseQueryResult<Catalog> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...catalogQuery(outletId), enabled: ready });
}

/**
 * "edge_only" while the cloud is out of reach (the outlet keeps selling from
 * the cached catalog); `catalogUpdatedAt` is the time of the catalog in use.
 */
export function useOrderingConnectivity(): OrderingConnectivity {
  const hydrated = useHydrated();
  const cloudOnline = useCloudConnection();
  const catalog = usePosCatalog();
  // The demo seed is only known in the browser: read it after hydration.
  const demoOffline =
    API_MOCK && hydrated && orderDemoSeed(readDemoSeed()) === "offline";
  const online = cloudOnline && !demoOffline;
  return {
    mode: online ? "online" : "edge_only",
    catalogUpdatedAt: catalog.data?.updatedAt ?? null,
  };
}

export function useNextCallNumber(enabled: boolean): UseQueryResult<string> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...callNumberQuery(outletId), enabled: enabled && ready });
}

export function useSubmitOrder(): UseMutationResult<
  PosOrderView,
  Error,
  SubmitOrderInput
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const intent = useIntentKey("order");
  return useMutation<PosOrderView, Error, SubmitOrderInput>({
    mutationFn: (input) =>
      submitOrder(outletId, { ...input, idempotencyKey: intent.keyFor(input) }),
    onSuccess: () => {
      intent.clear();
      // A takeaway order used its call number: the next one moves on.
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.callNumber(outletId),
      });
    },
  });
}

export function useFireLines(): UseMutationResult<
  PosOrderView,
  Error,
  FireLinesInput
> {
  const outletId = useOutletId();
  return useMutation<PosOrderView, Error, FireLinesInput>({
    mutationFn: (input) => fireLines(outletId, input),
  });
}

export function useParkedDrafts(): UseQueryResult<ParkedDraft[]> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...parkedDraftsQuery(outletId), enabled: ready });
}

export function useParkDraft(): UseMutationResult<
  ParkedDraft,
  Error,
  ParkDraftInput
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return useMutation<ParkedDraft, Error, ParkDraftInput>({
    mutationFn: (input) => parkDraft(outletId, input),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.parked(outletId),
      }),
  });
}

export function useResumeDraft(): UseMutationResult<
  ParkedDraft,
  Error,
  { id: string }
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return useMutation<ParkedDraft, Error, { id: string }>({
    mutationFn: ({ id }) => resumeDraft(outletId, id),
    // Taken or already gone: either way the list must be read again.
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.parked(outletId),
      }),
  });
}

// ---- Captain ---------------------------------------------------------------

export function useCaptainTables(): UseQueryResult<CaptainTable[]> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...captainTablesQuery(outletId), enabled: ready });
}

export function useTableOrder(tableId: string): UseQueryResult<TableOrderView> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...tableOrderQuery(outletId, tableId),
    enabled: ready && tableId !== "",
  });
}

export function useAddToTable(): UseMutationResult<
  TableOrderView,
  Error,
  AddToTableInput
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const intent = useIntentKey("table-order");
  return useMutation<TableOrderView, Error, AddToTableInput>({
    mutationFn: (input) =>
      addToTable(outletId, { ...input, idempotencyKey: intent.keyFor(input) }),
    onSuccess: (view, input) => {
      intent.clear();
      queryClient.setQueryData(
        posOrderKeys.tableOrder(outletId, input.tableId),
        view,
      );
      // An empty table became occupied.
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tables(outletId),
      });
    },
  });
}

export function useFireTableLines(): UseMutationResult<
  TableOrderView,
  Error,
  FireTableLinesInput
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return useMutation<TableOrderView, Error, FireTableLinesInput>({
    mutationFn: (input) => fireTableLines(outletId, input),
    onSuccess: (view, input) =>
      queryClient.setQueryData(
        posOrderKeys.tableOrder(outletId, input.tableId),
        view,
      ),
  });
}

// ---- Waiter calls ----------------------------------------------------------

/** Polls every 10 seconds while the screen is open. */
export function useServiceCalls(): UseQueryResult<ServiceCall[]> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...serviceCallsQuery(outletId), enabled: ready });
}

/** A call changed state: the inbox and the "call open" mark on the tables follow. */
function useCallMutation(
  run: (outletId: string, id: string) => Promise<ServiceCall>,
) {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return useMutation<ServiceCall, Error, { id: string }>({
    mutationFn: ({ id }) => run(outletId, id),
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.calls(outletId),
      });
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tables(outletId),
      });
    },
  });
}

export function useAcknowledgeCall(): UseMutationResult<
  ServiceCall,
  Error,
  { id: string }
> {
  return useCallMutation(acknowledgeCall);
}

export function useResolveCall(): UseMutationResult<
  ServiceCall,
  Error,
  { id: string }
> {
  return useCallMutation(resolveCall);
}
