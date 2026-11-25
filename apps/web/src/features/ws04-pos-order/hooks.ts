// The only data door for the cashier ordering and captain screens
// (docs/frontend.md): components import hooks from here and never touch
// apiFetch, useQuery or mock data. List hooks return the TanStack query result,
// so the list is `.data`. Mutations update the cache, so a screen rerenders
// from the hook result alone. Outside mock mode a call without a contract fails
// with an ApiError whose code is CONTRACT_PENDING (see `isContractPending`).
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { readActingStaffUserId } from "@/lib/api/acting-staff";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useRouteContext } from "@tanstack/react-router";
import { useTenantContext } from "@/lib/tenant-context";
import { useCloudConnection } from "@/features/ws02-edge/hooks";
import { useActiveStaff } from "@/features/ws01-device-pin/storage";
import {
  acknowledgeCall,
  closePendingOrder,
  closePendingPark,
  closePendingResume,
  otherCashierPending,
  pendingParkText,
  pendingOrderText,
  pendingResumes,
  addToTable,
  fireLines,
  fireTableLines,
  parkDraft,
  resolveCall,
  resumeDraft,
  submitOrder,
} from "./api";
import { cashierDraftKey, readDraft, writeDraft } from "./draft-store";
import { parseOrderSnapshot, replayAll } from "./order-flow";
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
  type OrderMeta,
  type OrderSnapshot,
  type OrderingConnectivity,
  type ParkDraftInput,
  type ParkedDraft,
  type PosOrderView,
  type ServiceCall,
  type SubmitOrderInput,
  type TableOrderView,
} from "./types";

export { useDraftCart } from "./draft-store";

/** What the screen sends: the order and the meta kept for a re-send. */
export type PlaceOrderInput = SubmitOrderInput & { meta?: OrderMeta };

/** A resumed parked cart; `missing` lines left the catalog and were not restored. */
export type ResumedDraft = ParkedDraft & { missing: number };

/** True when the server has no contract for the call yet (show "belum tersambung"). */
export function isContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/**
 * The cashier at the till, as the server names the actor: the active (PIN)
 * cashier when there is one, else the signed-in user. A keyed send never
 * shares its key with another actor.
 */
function useActorId(): string {
  const staff = useActiveStaff();
  const session = (
    useRouteContext({ strict: false }) as {
      session?: { user?: { id?: string } } | null;
    }
  ).session;
  // The token's own staff first (what the server records as the actor), then
  // the device's active staff label, then the signed-in user.
  return readActingStaffUserId() ?? staff?.userId ?? session?.user?.id ?? "";
}

/** The key of this cashier's cart in this outlet (see `cashierDraftKey`). */
export function useCashierDraftKey(): string {
  return cashierDraftKey(useOutletId(), useActorId());
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
 * The key lives in this module, per draft key, not in the component: the cart
 * screen can unmount and mount again (navigation, reload of the route) while
 * the call is in flight, and a retry from the new screen must still reuse it.
 * The fingerprint carries the outlet, so another outlet never shares a key.
 */
const intentKeys = new Map<string, { fingerprint: string; key: string }>();

function intentKeyFor(
  prefix: string,
  draftKey: string,
  outletId: string,
  input: unknown,
): string {
  const slot = `${prefix}:${draftKey}`;
  const fingerprint = JSON.stringify([outletId, input]);
  const current = intentKeys.get(slot);
  if (current?.fingerprint === fingerprint) return current.key;
  const key = `${prefix}:${globalThis.crypto.randomUUID()}`;
  intentKeys.set(slot, { fingerprint, key });
  return key;
}

function clearIntentKey(prefix: string, draftKey: string): void {
  intentKeys.delete(`${prefix}:${draftKey}`);
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
  // One source of truth: the ws02-edge status (the `_ops` header badge reads
  // it too). `?demo=offline` flips that status in the mock, not here.
  const cloudOnline = useCloudConnection();
  const catalog = usePosCatalog();
  return {
    mode: cloudOnline ? "online" : "edge_only",
    catalogUpdatedAt: catalog.data?.updatedAt ?? null,
  };
}

export function useNextCallNumber(enabled: boolean): UseQueryResult<string> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...callNumberQuery(outletId), enabled: enabled && ready });
}

/**
 * `draftKey` is the cart this order is made from. The draft is emptied here,
 * on the mutation itself, so it is cleared even when the screen that started
 * the call is gone by the time it succeeds; the screen only navigates.
 */
export function useSubmitOrder({
  draftKey,
}: {
  draftKey: string;
}): UseMutationResult<PosOrderView, Error, PlaceOrderInput> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  return useMutation<PosOrderView, Error, PlaceOrderInput>({
    // The keyed intent is persisted by the api call itself (order-flow), so a
    // refresh after an unknown outcome repeats the same keys.
    mutationFn: ({ meta, ...input }) =>
      submitOrder(outletId, actorId, draftKey, input, meta),
    onSuccess: () => {
      writeDraft(draftKey, []);
      // A takeaway order used its call number: the next one moves on.
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.callNumber(outletId),
      });
    },
  });
}

/**
 * The send of this cart whose answer is not known (lost reply, refresh, copied
 * tab): its lines and meta as they were sent, or null. `refresh` re-reads it
 * after a send; `close` ends a refused (reused) key once the cashier has
 * checked the open orders.
 */
export function usePendingOrder(
  draftKey: string,
  kind: "order" | "park" = "order",
): {
  pending: OrderSnapshot | null;
  refresh: () => void;
  close: () => void;
} {
  const outletId = useOutletId();
  const actorId = useActorId();
  const text = useSyncExternalStore(
    subscribePending,
    () =>
      kind === "order"
        ? pendingOrderText(outletId, actorId, draftKey)
        : pendingParkText(outletId, actorId, draftKey),
    () => null,
  );
  const pending = useMemo(() => parseOrderSnapshot(text), [text]);
  const close = useCallback(() => {
    if (kind === "order") closePendingOrder(outletId, actorId, draftKey);
    else closePendingPark(outletId, actorId, draftKey);
    notifyPending();
  }, [kind, outletId, actorId, draftKey]);
  return { pending, refresh: notifyPending, close };
}

/** Another cashier of this outlet has a send whose answer is not known. */
export function useOtherCashierPending(): boolean {
  const outletId = useOutletId();
  const actorId = useActorId();
  return useSyncExternalStore(
    subscribePending,
    () => otherCashierPending(outletId, actorId),
    () => false,
  );
}

/** Closes an unclear resume of one parked cart after the cashier checked. */
export function useCloseResume(): (parkedId: string) => void {
  const outletId = useOutletId();
  const actorId = useActorId();
  return useCallback(
    (parkedId: string) => {
      closePendingResume(outletId, actorId, parkedId);
      notifyPending();
    },
    [outletId, actorId],
  );
}

const pendingListeners = new Set<() => void>();
function subscribePending(listener: () => void): () => void {
  pendingListeners.add(listener);
  // Another tab changed its own storage copy: nothing to do; a copied tab only
  // shares the keys it started with.
  return () => {
    pendingListeners.delete(listener);
  };
}
function notifyPending(): void {
  pendingListeners.forEach((listener) => listener());
}

/**
 * Replays a resume that was sent but not answered, when the screen opens: the
 * server gives the same parked cart for the same key and it is put back in the
 * draft. Nothing runs without an outlet and a cashier.
 */
export function useReplayPendingResumes({ draftKey }: { draftKey: string }): {
  data: ResumedDraft | null;
  failures: { id: string; error: unknown }[];
  dismiss: (id: string) => void;
} {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  const [state, setState] = useState<{
    data: ResumedDraft | null;
    failures: { id: string; error: unknown }[];
  }>({ data: null, failures: [] });
  // An order send that is not answered yet comes first: nothing is replayed
  // over it.
  const blocked = usePendingOrder(draftKey).pending !== null;
  useEffect(() => {
    if (blocked || outletId === "" || actorId === "") return;
    const ids = pendingResumes(outletId, actorId);
    if (ids.length === 0) return;
    void replayAll(ids, (id) =>
      resumeDraft(outletId, actorId, id, (draft) =>
        writeDraft(draftKey, [...readDraft(draftKey), ...draft.lines]),
      ),
    ).then(({ results, failures }) => {
      setState({
        data: results.filter((item) => item !== null).at(-1) ?? null,
        failures,
      });
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.parked(outletId),
      });
    });
  }, [blocked, outletId, actorId, draftKey, queryClient]);
  const dismiss = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      failures: current.failures.filter((failure) => failure.id !== id),
    }));
  }, []);
  return { data: state.data, failures: state.failures, dismiss };
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

export function useParkDraft({
  draftKey = "kasir",
}: { draftKey?: string } = {}): UseMutationResult<
  ParkedDraft,
  Error,
  ParkDraftInput & { meta?: OrderMeta }
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  return useMutation<ParkedDraft, Error, ParkDraftInput & { meta?: OrderMeta }>(
    {
      mutationFn: ({ meta, ...input }) =>
        parkDraft(outletId, actorId, draftKey, input, meta),
      onSuccess: () =>
        void queryClient.invalidateQueries({
          queryKey: posOrderKeys.parked(outletId),
        }),
    },
  );
}

/**
 * The parked draft is taken off the list by the server; its lines are added to
 * the draft `draftKey` here, on the mutation, so they are not lost if the
 * sheet that started the call has closed.
 */
export function useResumeDraft({
  draftKey,
}: {
  draftKey: string;
}): UseMutationResult<ResumedDraft | null, Error, { id: string }> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useActorId();
  return useMutation<ResumedDraft | null, Error, { id: string }>({
    // The lines go into the draft inside the call, before its key is
    // forgotten: a lost reply or a refresh cannot lose the parked cart.
    mutationFn: ({ id }) =>
      resumeDraft(outletId, actorId, id, (draft) =>
        writeDraft(draftKey, [...readDraft(draftKey), ...draft.lines]),
      ),
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

/** `draftKey` is the table's cart (`captain:${tableId}`), emptied on success. */
export function useAddToTable({
  draftKey,
}: {
  draftKey: string;
}): UseMutationResult<TableOrderView, Error, AddToTableInput> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  return useMutation<TableOrderView, Error, AddToTableInput>({
    mutationFn: (input) =>
      addToTable(outletId, {
        ...input,
        idempotencyKey: intentKeyFor("table-order", draftKey, outletId, input),
      }),
    onSuccess: (view, input) => {
      clearIntentKey("table-order", draftKey);
      writeDraft(draftKey, []);
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
