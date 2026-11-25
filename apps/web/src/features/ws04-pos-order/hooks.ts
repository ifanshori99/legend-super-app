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
  closePendingFire,
  continueDraftOrder,
  closePendingOpen,
  closePendingOrder,
  closePendingPark,
  closePendingResume,
  openTable,
  otherCashierPending,
  pendingCaptainSends,
  pendingFires,
  pendingOpenPax,
  pendingParkText,
  pendingOrderText,
  pendingResumes,
  addToTable,
  fireLines,
  fireTableLines,
  parkDraft,
  resendCaptainOrder,
  resendFire,
  resolveCall,
  resumeDraft,
  submitOrder,
} from "./api";
import { captainDraftKey, removeSentLines } from "./captain-wire";
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
  type CaptainSendInput,
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
  type TableOrdersView,
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

/** The table and its orders: one order per send, never merged. */
export function useTableOrder(
  tableId: string,
): UseQueryResult<TableOrdersView> {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...tableOrderQuery(outletId, tableId),
    enabled: ready && tableId !== "",
  });
}

/** Captain actor: mock mode has no signed-in captain, the real one must. */
function useCaptainActorId(): string {
  const actorId = useActorId();
  return actorId || (API_MOCK ? "mock" : "");
}

/**
 * The captain's cart key for the table's open session (outlet + captain +
 * session); null while the table has no session or no captain is known, so
 * nothing can be put in a cart that has nowhere to go.
 */
export function useCaptainCartKey(tableId: string): string | null {
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  const table = useTableOrder(tableId).data?.table;
  const sessionId = table?.sessionId ?? null;
  // Pay first is the cashier's table: no cart for the captain.
  if (
    sessionId === null ||
    actorId === "" ||
    table?.paymentMode === "pay_first"
  )
    return null;
  return captainDraftKey(outletId, actorId, sessionId);
}

/** Carts whose order is being sent right now (this tab). */
const sending = new Set<string>();

/**
 * True while the captain's order of this cart is on its way or its answer is
 * not known: the cart cannot change under a send, and the same bytes go again.
 */
export function useCaptainCartLocked(draftKey: string | null): boolean {
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  const inFlight = useSyncExternalStore(
    subscribePending,
    () => draftKey !== null && sending.has(draftKey),
    () => false,
  );
  const unclear = useSyncExternalStore(
    subscribePending,
    () =>
      draftKey !== null &&
      pendingOrderText(outletId, actorId, draftKey) !== null,
    () => false,
  );
  return inFlight || unclear;
}

/** The unclear send of a captain cart (restore and close), see `usePendingOrder`. */
export function usePendingCaptainOrder(draftKey: string | null) {
  return usePendingOrder(draftKey ?? "captain:none");
}

/** `draftKey` is the table session's cart (`useCaptainCartKey`). */
export function useAddToTable({
  draftKey,
}: {
  draftKey: string;
}): UseMutationResult<PosOrderView, Error, CaptainSendInput> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  return useMutation<PosOrderView, Error, CaptainSendInput>({
    mutationFn: async (input) => {
      sending.add(draftKey);
      notifyPending();
      try {
        return await addToTable(outletId, actorId, draftKey, input);
      } finally {
        sending.delete(draftKey);
        notifyPending();
      }
    },
    onSuccess: (_order, input) => {
      // Only what was sent leaves the cart.
      writeDraft(draftKey, removeSentLines(readDraft(draftKey), input.lines));
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tableOrder(outletId, input.tableId),
      });
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tables(outletId),
      });
    },
  });
}

/** Seat a walk-in party at an empty table (keyed). */
export function useOpenTable(
  tableId: string,
): UseMutationResult<void, Error, { pax: number }> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  return useMutation<void, Error, { pax: number }>({
    mutationFn: ({ pax }) => openTable(outletId, actorId, tableId, pax),
    onSettled: () => {
      notifyPending();
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tableOrder(outletId, tableId),
      });
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tables(outletId),
      });
    },
  });
}

/** The guest count of a seat whose answer is not known, and how to close it. */
export function usePendingOpen(tableId: string): {
  pax: number | null;
  close: () => void;
} {
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  const pax = useSyncExternalStore(
    subscribePending,
    () => pendingOpenPax(outletId, actorId, tableId),
    () => null,
  );
  const close = useCallback(() => {
    closePendingOpen(outletId, actorId, tableId);
    notifyPending();
  }, [outletId, actorId, tableId]);
  return { pax, close };
}

/** Submit an order of the table that was created but not submitted. */
export function useContinueDraft(
  tableId: string,
): UseMutationResult<
  void,
  Error,
  { orderId: string; tableSessionId: string | null }
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  return useMutation<
    void,
    Error,
    { orderId: string; tableSessionId: string | null }
  >({
    mutationFn: ({ orderId, tableSessionId }) =>
      continueDraftOrder(outletId, actorId, orderId, tableSessionId),
    onSettled: () => {
      notifyPending();
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tableOrder(outletId, tableId),
      });
    },
  });
}

export function useFireTableLines(): UseMutationResult<
  void,
  Error,
  FireTableLinesInput
> {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  return useMutation<void, Error, FireTableLinesInput>({
    mutationFn: (input) => fireTableLines(outletId, actorId, input),
    onSettled: (_data, _error, input) => {
      notifyPending();
      void queryClient.invalidateQueries({
        queryKey: posOrderKeys.tableOrder(outletId, input.tableId),
      });
    },
  });
}

/** Fires whose answer is not known: resend (same items) or close after checking. */
export function usePendingFires(): {
  pending: { orderId: string; itemIds: string[] }[];
  close: (orderId: string) => void;
} {
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  const text = useSyncExternalStore(
    subscribePending,
    () => JSON.stringify(pendingFires(outletId, actorId)),
    () => "[]",
  );
  const pending = useMemo(
    () => JSON.parse(text) as { orderId: string; itemIds: string[] }[],
    [text],
  );
  const close = useCallback(
    (orderId: string) => {
      closePendingFire(outletId, actorId, orderId);
      notifyPending();
    },
    [outletId, actorId],
  );
  return { pending, close };
}

const NO_SENDS = '{"orders":[],"seats":[]}';

/**
 * Every captain send whose answer is not known (orders, seats, fires) for this
 * outlet and captain, whether or not its table still has a session: resend
 * from what was stored, or close after checking.
 */
export function useUnclearSends() {
  const queryClient = useQueryClient();
  const outletId = useOutletId();
  const actorId = useCaptainActorId();
  const text = useSyncExternalStore(
    subscribePending,
    () => JSON.stringify(pendingCaptainSends(outletId, actorId)),
    () => NO_SENDS,
  );
  const sends = useMemo(
    () => JSON.parse(text) as ReturnType<typeof pendingCaptainSends>,
    [text],
  );
  const fires = usePendingFires();
  const resend = useMutation<
    void,
    Error,
    | { kind: "order"; draftKey: string }
    | { kind: "seat"; tableId: string; pax: number }
    | { kind: "fire"; orderId: string }
  >({
    mutationFn: (target) =>
      target.kind === "order"
        ? resendCaptainOrder(outletId, actorId, target.draftKey).then(
            () => undefined,
          )
        : target.kind === "seat"
          ? openTable(outletId, actorId, target.tableId, target.pax).then(
              () => undefined,
            )
          : resendFire(outletId, actorId, target.orderId),
    onSettled: () => {
      notifyPending();
      void queryClient.invalidateQueries({ queryKey: ["pos-order", outletId] });
    },
  });
  const closeOrder = useCallback(
    (draftKey: string) => {
      closePendingOrder(outletId, actorId, draftKey);
      notifyPending();
    },
    [outletId, actorId],
  );
  const closeSeat = useCallback(
    (tableId: string) => {
      closePendingOpen(outletId, actorId, tableId);
      notifyPending();
    },
    [outletId, actorId],
  );
  return {
    orders: sends.orders,
    seats: sends.seats,
    fires: fires.pending,
    resend,
    closeOrder,
    closeSeat,
    closeFire: fires.close,
  };
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
