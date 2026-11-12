// The data door of the charge screen: components import these hooks and never
// touch the endpoints. The collect hook holds one idempotency key per charge
// until the answer is known, so a second click or a retry after a dropped
// answer replays the same request instead of recording the cash twice.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { ApiError } from "@/lib/api/errors";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import { CONTRACT_PENDING, collectCharge } from "./charge-api";
import { chargeFailureKind } from "./charge-logic";
import { issueChargeKeys, issueChargeQuery } from "./charge-queries";

/** True when the server has no contract for the call yet. */
export function isChargeContractPending(error: unknown): boolean {
  return error instanceof ApiError && error.code === CONTRACT_PENDING;
}

function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

export function useIssueCharge(chargeId: string) {
  const outletId = useOutletId();
  return useQuery({
    ...issueChargeQuery(outletId, chargeId),
    enabled: (API_MOCK || outletId !== "") && chargeId !== "",
  });
}

export function useCollectIssueCharge(chargeId: string) {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useRef<{ receivedIdr: number; key: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (receivedIdr: number) => {
      // Same amount, same key: a retry replays. A different amount is a new
      // intent.
      if (intent.current?.receivedIdr !== receivedIdr)
        intent.current = {
          receivedIdr,
          key: globalThis.crypto.randomUUID(),
        };
      return collectCharge(chargeId, {
        receivedIdr,
        idempotencyKey: intent.current.key,
      });
    },
    onSuccess: () => {
      intent.current = null;
      // Only a known answer refreshes the charge. After an unknown result the
      // cashier checks the status by hand (the screen says so).
      void queryClient.invalidateQueries({
        queryKey: issueChargeKeys.charge(outletId, chargeId),
      });
    },
    onError: (error) => {
      // A refusal recorded nothing: the next try is a new intent. An unknown
      // result keeps the key (the cashier checks the status first).
      if (
        error instanceof ApiError &&
        chargeFailureKind(error.status) === "failed"
      )
        intent.current = null;
    },
  });
  const error = mutation.error instanceof ApiError ? mutation.error : null;
  return {
    collect: (receivedIdr: number) => mutation.mutate(receivedIdr),
    pending: mutation.isPending,
    succeeded: mutation.isSuccess,
    failure: error
      ? { kind: chargeFailureKind(error.status), message: error.message }
      : null,
    /** Back to a clean form after the cashier has checked the status. */
    reset: () => mutation.reset(),
  };
}
