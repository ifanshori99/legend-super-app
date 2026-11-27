// The data door of the charge screen: components import these hooks and never
// touch the endpoints. Each attempt (cash, QRIS, recording a card sale,
// starting a card sale) holds one idempotency key until the answer is known
// (in localStorage, so a refresh or a second tab replays it too), and reads the
// charge again right before sending, within a deadline, so a code or an EDC
// sale started elsewhere is never collected on top of (legend-f1mmf (e)).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import type { CollectChargeAtPosInput } from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import {
  collectCharge,
  fetchIssueCharge,
  resolveChargeAttempt,
  startChargeEdc,
  type ResolveChargeAttemptInput,
} from "./charge-api";
import type { IssueChargeDetail } from "./charge-endpoints";
import {
  beginAttempt,
  endAttempt,
  hasUnresolved,
  lockedAttempt,
  markChecked,
  markRefused,
  rememberSaleKey,
  saleStartKey,
  type ChargeKeyScope,
} from "./charge-key-store";
import {
  chargeFailureKind,
  collectKeyAfter,
  edcStartKeyAfter,
} from "./charge-logic";
import {
  answerSettles,
  canCollect,
  chargePhase,
  codeFacts,
  CHARGE_POLL_MS,
  COLLECT_DEADLINE_MS,
  EDC_START_DEADLINE_MS,
  PRECHECK_DEADLINE_MS,
  RESOLVE_DEADLINE_MS,
  readWithin,
  requestSignature,
  withDeadline,
  type EdcStartFacts,
} from "./charge-method-logic";
import {
  chargeApproversQuery,
  chargeTerminalsQuery,
  issueChargeKeys,
  issueChargeQuery,
} from "./charge-queries";

/** What the cashier chose to collect with; the hook adds the idempotency key. */
export type ChargeCollectRequest = CollectChargeAtPosInput extends infer Input
  ? Input extends unknown
    ? Omit<Input, "idempotencyKey">
    : never
  : never;

/** One attempt of the screen: a collect, or the start of a card sale. */
export type ChargeAttemptRequest = ChargeCollectRequest | EdcStartFacts;

function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

// Session fallback when the browser refuses localStorage (private mode, full).
const memory = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
};

function withStorage<T>(
  run: (storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) => T,
): T {
  try {
    return run(window.localStorage);
  } catch {
    return run(memoryStorage);
  }
}

/**
 * Nothing was sent. `not_read`: the charge could not be read before sending
 * (the deadline passed or the server refused). `changed`: the charge read
 * differently than the screen showed. `held`: another attempt of this browser
 * is still without an answer.
 */
class NotSentError extends Error {
  constructor(readonly reason: "not_read" | "changed" | "held") {
    super("");
  }
}

export function useIssueCharge(chargeId: string) {
  const outletId = useOutletId();
  return useQuery({
    ...issueChargeQuery(outletId, chargeId),
    enabled: (API_MOCK || outletId !== "") && chargeId !== "",
  });
}

/**
 * Who may approve the settle at this outlet, without the caller (the server
 * refuses the caller as approver).
 */
export function useChargeApprovers(
  action: "void" | "edc_standalone",
  callerId: string,
  enabled: boolean,
) {
  const outletId = useOutletId();
  return useQuery({
    ...chargeApproversQuery(outletId, action),
    enabled: enabled && (API_MOCK || outletId !== ""),
    select: (options) =>
      options.filter(
        (option) => option.userId.toLowerCase() !== callerId.toLowerCase(),
      ),
  });
}

/** The card terminals the charge may be sent to. */
export function useChargeTerminals(enabled: boolean) {
  const outletId = useOutletId();
  return useQuery({
    ...chargeTerminalsQuery(outletId),
    enabled: enabled && (API_MOCK || outletId !== ""),
  });
}

// An attempt left unresolved by this browser (refresh, another tab): the store
// event tells other tabs; the snapshots are strings, so they are stable.
function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** The screen's view of an attempt this browser holds for the charge. */
export type ChargeLock = { signature: string; key: string };

export function useChargeAttempts(
  chargeId: string,
  charge: IssueChargeDetail | undefined,
) {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const sending = useRef(false);
  // The key of the request in flight, so a late answer never clears the key of
  // another tab's attempt, and whether it was that key's first send.
  const attempt = useRef<{ key: string; firstSend: boolean } | null>(null);
  // The last refusal ended its key: nothing can be recorded for it, so it
  // reads as a refusal (401/403/429 on a first send).
  const [lastEnded, setLastEnded] = useState(false);
  const scope: ChargeKeyScope = { outletId, chargeId };
  const queryKey = issueChargeKeys.charge(outletId, chargeId);
  const facts = codeFacts(charge);

  const unresolved = useSyncExternalStore(
    subscribeStorage,
    () => withStorage((storage) => hasUnresolved(storage, scope)),
    () => false,
  );
  const lockSnapshot = useSyncExternalStore(
    subscribeStorage,
    () =>
      withStorage((storage) => {
        const lock = lockedAttempt(storage, scope, facts);
        return lock ? `${lock.key} ${lock.signature}` : "";
      }),
    () => "",
  );
  const lock: ChargeLock | null = lockSnapshot
    ? {
        key: lockSnapshot.slice(0, lockSnapshot.indexOf(" ")),
        signature: lockSnapshot.slice(lockSnapshot.indexOf(" ") + 1),
      }
    : null;

  // The storage event only reaches other tabs: this tab tells itself.
  const notify = () => window.dispatchEvent(new StorageEvent("storage"));
  function store<T>(
    run: (storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) => T,
  ): T {
    const result = withStorage(run);
    notify();
    return result;
  }

  const mutation = useMutation({
    // The tap waits for the server even after the cashier leaves the screen;
    // no automatic retry: the cashier checks the status first.
    retry: false,
    mutationFn: async (request: ChargeAttemptRequest) => {
      // (e) The read before sending has a deadline; a failed read sends
      // nothing and frees nothing.
      const read = await readWithin(
        (signal) => fetchIssueCharge(chargeId, signal),
        PRECHECK_DEADLINE_MS,
      ).catch(() => {
        throw new NotSentError("not_read");
      });
      queryClient.setQueryData(queryKey, read);
      const allowed =
        request.method === "edc_start"
          ? chargePhase(read) === "choose"
          : canCollect(read, request);
      if (!allowed) throw new NotSentError("changed");
      // The charge was just read open: together with the server's 409/422 for
      // the key, this is what lets the cashier change method.
      store((storage) => markChecked(storage, scope));
      const begun = store((storage) =>
        beginAttempt(
          storage,
          scope,
          requestSignature(read, request),
          () => globalThis.crypto.randomUUID(),
          codeFacts(read),
        ),
      );
      if (begun.conflict) throw new NotSentError("held");
      attempt.current = { key: begun.key, firstSend: begun.firstSend };
      // A request that never answers must not lock the screen: after the
      // deadline the result is unknown (the status check follows).
      if (request.method === "edc_start") {
        // The agent answers when the terminal is done (up to 120 s): the
        // screen keeps reading the server meanwhile, so the sale shows.
        const poll = setInterval(() => {
          void queryClient.refetchQueries({ queryKey }).catch(() => undefined);
        }, CHARGE_POLL_MS);
        try {
          const sale = await withDeadline(
            startChargeEdc(chargeId, {
              terminalId: request.terminalId,
              idempotencyKey: begun.key,
            }),
            EDC_START_DEADLINE_MS,
          );
          return { kind: "edc" as const, saleId: sale.id };
        } finally {
          clearInterval(poll);
        }
      }
      const answer = await withDeadline(
        collectCharge(chargeId, {
          ...request,
          idempotencyKey: begun.key,
        } as CollectChargeAtPosInput),
        COLLECT_DEADLINE_MS,
      );
      return { kind: "collect" as const, answer };
    },
    onSuccess: async (result) => {
      const key = attempt.current?.key;
      if (result.kind === "edc" && key)
        // The sale is the server's now; its start key settles it later.
        store((storage) => rememberSaleKey(storage, scope, result.saleId, key));
      store((storage) => endAttempt(storage, scope, key));
      if (result.kind === "collect") {
        const { answer } = result;
        // Show what the answer says at once (a fresh code locks the methods);
        // the refetch confirms it. A QRIS answer is a code, not money.
        queryClient.setQueryData<IssueChargeDetail>(queryKey, (current) =>
          current
            ? {
                ...current,
                ...answer.charge,
                payment: answer.payment ?? current.payment,
              }
            : current,
        );
      }
      // The screen shows the sale or the code from the server before the
      // attempt ends, so the methods never look free in between.
      await queryClient.refetchQueries({ queryKey }).catch(() => undefined);
    },
    onError: (error, request) => {
      // 409/422 keep the key and free other methods once the charge reads
      // open; unknown results keep it. Auth and rate limits on the key's first
      // send, and any other refusal, recorded nothing: the next try is new.
      setLastEnded(false);
      if (!(error instanceof ApiError) || attempt.current === null) return;
      const { key, firstSend } = attempt.current;
      const action =
        request.method === "edc_start"
          ? edcStartKeyAfter(error.status, firstSend)
          : collectKeyAfter(error.status, firstSend);
      if (action === "refused")
        store((storage) => markRefused(storage, scope, key));
      else if (action === "end") {
        setLastEnded(true);
        store((storage) => endAttempt(storage, scope, key));
      }
    },
    onSettled: () => {
      sending.current = false;
      attempt.current = null;
    },
  });

  // Anything that is not a clear refusal is unknown: a dropped answer, an
  // unreadable answer, or an attempt this browser left unresolved. A read
  // before sending that failed sent nothing: it says so, and the lock stays.
  const { error } = mutation;
  let failure: {
    kind: "unknown" | "failed" | "not_read" | "changed" | "held";
    code: string | null;
    message: string;
  } | null = null;
  if (error instanceof NotSentError)
    failure = { kind: error.reason, code: null, message: "" };
  else if (error instanceof ApiError)
    failure = {
      kind: lastEnded ? "failed" : chargeFailureKind(error.status),
      code: error.code,
      message: error.message,
    };
  else if (error) failure = { kind: "unknown", code: null, message: "" };
  else if (unresolved && !mutation.isPending)
    failure = { kind: "unknown", code: null, message: "" };

  const data = mutation.data?.kind === "collect" ? mutation.data.answer : null;
  const settled = answerSettles(data ?? undefined);
  const variables = mutation.variables;

  return {
    send: (request: ChargeAttemptRequest) => {
      // Two taps in one frame: the button is not disabled yet, the ref is.
      if (sending.current) return;
      sending.current = true;
      mutation.mutate(request);
    },
    pending: mutation.isPending,
    /** What is being sent, for the waiting text. */
    sendingMethod: mutation.isPending ? (variables?.method ?? null) : null,
    /** The server marked the charge paid in this answer. */
    settled,
    /** The method of the answer above, for the receipt line. */
    settledMethod: settled ? (variables?.method ?? null) : null,
    failure,
    /** The attempt that holds the picker to its own method (a). */
    lock,
    /** The key this browser started the sale with, if it did. */
    saleKey: (saleId: string) =>
      withStorage((storage) => saleStartKey(storage, scope, saleId)),
    /** The server was read and the charge is not paid: back to the form. */
    resolve: () => {
      store((storage) => markChecked(storage, scope));
      mutation.reset();
    },
    /** Nothing was sent (the read before sending failed): back to the form. */
    clear: () => mutation.reset(),
    /**
     * Reads the charge now within a deadline (the status check): the result,
     * or null when the server did not answer in time.
     */
    checkNow: async (): Promise<IssueChargeDetail | null> => {
      try {
        const read = await readWithin(
          (signal) => fetchIssueCharge(chargeId, signal),
          PRECHECK_DEADLINE_MS,
        );
        queryClient.setQueryData(queryKey, read);
        return read;
      } catch {
        return null;
      }
    },
    /** A supervisor settled the attempt with this key: it is answered. */
    settledAttempt: (key: string) => {
      store((storage) => endAttempt(storage, scope, key));
      mutation.reset();
    },
  };
}

/**
 * A supervisor settles a cash or card attempt that never answered (legend-
 * f1mmf (d)). The answer carries the server's charge, shown at once.
 */
export function useResolveChargeAttempt(chargeId: string) {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const queryKey = issueChargeKeys.charge(outletId, chargeId);
  return useMutation<
    Awaited<ReturnType<typeof resolveChargeAttempt>>,
    Error,
    ResolveChargeAttemptInput
  >({
    retry: false,
    // The settle is replayed safely with the same key: after the deadline the
    // dialog may be opened and sent again.
    mutationFn: (input) =>
      withDeadline(resolveChargeAttempt(chargeId, input), RESOLVE_DEADLINE_MS),
    onSuccess: (answer) => {
      queryClient.setQueryData(queryKey, answer.charge);
      void queryClient.invalidateQueries({ queryKey });
    },
    // Whatever happened, the screen reads the server again.
    onError: () => void queryClient.invalidateQueries({ queryKey }),
  });
}
