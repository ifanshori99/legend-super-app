// The data door of the charge screen: components import these hooks and never
// touch the endpoints. The collect hook holds one idempotency key per request
// until the answer is known (in localStorage, so a refresh or a second tab
// replays it too), and reads the charge again right before sending, so a code
// or an EDC sale started elsewhere is never collected on top of.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useSyncExternalStore } from "react";
import type { CollectChargeAtPosInput } from "@starter/shared/qr-order";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { CONTRACT_PENDING, collectCharge } from "./charge-api";
import type { IssueChargeDetail } from "./charge-endpoints";
import {
  beginAttempt,
  endAttempt,
  hasUnresolved,
  markChecked,
  type ChargeKeyScope,
} from "./charge-key-store";
import { chargeFailureKind } from "./charge-logic";
import {
  answerSettles,
  canCollect,
  requestSignature,
} from "./charge-method-logic";
import { issueChargeKeys, issueChargeQuery } from "./charge-queries";

/** True when the server has no contract for the call yet. */
export function isChargeContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

/** What the cashier chose to collect with; the hook adds the idempotency key. */
export type ChargeCollectRequest = CollectChargeAtPosInput extends infer Input
  ? Input extends unknown
    ? Omit<Input, "idempotencyKey">
    : never
  : never;

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

/** Nothing was sent: the charge changed, or another request is unresolved. */
class NotSentError extends Error {}

export function useIssueCharge(chargeId: string) {
  const outletId = useOutletId();
  return useQuery({
    ...issueChargeQuery(outletId, chargeId),
    enabled: (API_MOCK || outletId !== "") && chargeId !== "",
  });
}

// An attempt left unresolved by this browser (refresh, another tab): the store
// event tells other tabs; the snapshot is a boolean, so it is stable.
function subscribeStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

export function useCollectIssueCharge(chargeId: string) {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const sending = useRef(false);
  const scope: ChargeKeyScope = { outletId, chargeId };
  const queryKey = issueChargeKeys.charge(outletId, chargeId);

  const unresolved = useSyncExternalStore(
    subscribeStorage,
    () => withStorage((storage) => hasUnresolved(storage, scope)),
    () => false,
  );

  const mutation = useMutation({
    // The tap waits for the server even after the cashier leaves the screen;
    // no automatic retry: the cashier checks the status first.
    retry: false,
    mutationFn: async (request: ChargeCollectRequest) => {
      const charge = await queryClient
        .fetchQuery({ ...issueChargeQuery(outletId, chargeId), staleTime: 0 })
        .catch((error: unknown) => {
          throw new NotSentError(error instanceof Error ? error.message : "");
        });
      if (!canCollect(charge, request)) throw new NotSentError("");
      const attempt = withStorage((storage) =>
        beginAttempt(storage, scope, requestSignature(charge, request), () =>
          globalThis.crypto.randomUUID(),
        ),
      );
      if (attempt.conflict) throw new NotSentError("");
      return collectCharge(chargeId, {
        ...request,
        idempotencyKey: attempt.key,
      } as CollectChargeAtPosInput);
    },
    onSuccess: (answer) => {
      withStorage((storage) => endAttempt(storage, scope));
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
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) => {
      // A refusal recorded nothing: the next try is a new intent. An unknown
      // result keeps the key (the cashier checks the status first).
      if (
        error instanceof ApiError &&
        chargeFailureKind(error.status) === "failed"
      )
        withStorage((storage) => endAttempt(storage, scope));
    },
    onSettled: () => {
      sending.current = false;
    },
  });

  // Anything that is not a clear refusal is unknown: a dropped answer, an
  // unreadable answer, or an attempt this browser left unresolved.
  const { error } = mutation;
  let failure: { kind: "unknown" | "failed"; message: string } | null = null;
  if (error instanceof ApiError)
    failure = { kind: chargeFailureKind(error.status), message: error.message };
  else if (error) failure = { kind: "unknown", message: "" };
  else if (unresolved && !mutation.isPending)
    failure = { kind: "unknown", message: "" };

  return {
    collect: (request: ChargeCollectRequest) => {
      // Two taps in one frame: the button is not disabled yet, the ref is.
      if (sending.current) return;
      sending.current = true;
      mutation.mutate(request);
    },
    pending: mutation.isPending,
    /** The server marked the charge paid in this answer. */
    settled: answerSettles(mutation.data),
    /** The method of the answer above, for the receipt line. */
    settledMethod: answerSettles(mutation.data)
      ? (mutation.variables?.method ?? null)
      : null,
    failure,
    /** The server was read and the charge is not paid: back to the form. */
    resolve: () => {
      withStorage((storage) => markChecked(storage, scope));
      mutation.reset();
    },
  };
}
