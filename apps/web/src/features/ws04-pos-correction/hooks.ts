// The only data door for the POS correction screens (docs/frontend.md):
// components import hooks from here and never touch the API or the mock.
//
// A discount, void or refund first asks the supervisor's override (reason and
// PIN in, `overrideId` out), then sends the correction with that override in
// one mutation, so the PIN never outlives the call. One idempotency key per
// intent: the same input keeps its key until it succeeds, so a retry after a
// timeout or a double tap is recorded once (a changed input is a new intent).
// A discount or refund whose answer never arrived (status 0, 408, 409, 5xx) is
// UNCERTAIN: the key then stays even when the input changes, the order is
// re-read and the screen locks its form, so one intent is never recorded twice.
// Only a definite 4xx refusal frees the key.
import { useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { API_MOCK } from "@/lib/api/mock-flag";
import { useTenantContext } from "@/lib/tenant-context";
import {
  paperWidthOf,
  readTabletPrinter,
} from "../ws04-pos-kasir/print/printer-settings";
import { deliverToTabletPrinter } from "../ws04-pos-kasir/print/send-to-printer";
import { requestOverride } from "../ws04-pos-kasir/shift-api";
import { useSupervisorOptions } from "../ws04-pos-kasir/shift-hooks";
import type { OverrideAction } from "../ws04-pos-kasir/types";
import {
  applyManualDiscount,
  printOrderReceipt,
  refundOrder,
  voidOrderItem,
  type ApplyDiscountInput,
  type CorrectionApproval,
  type RefundInput,
  type VoidItemInput,
} from "./api";
import {
  correctionFailureKind,
  nextIdempotencyKey,
  type CorrectionFailureKind,
  type IntentKey,
} from "./correction-logic";
import {
  correctionOrderQuery,
  correctionPolicyQuery,
  posCorrectionKeys,
  receiptDocumentQuery,
} from "./queries";

/** The outlet this screen works in; "" when none (queries stay idle). */
function useOutletId(): string {
  return useTenantContext().outlet?.id ?? "";
}

/** Mock mode needs no outlet; real calls do. */
function useReady(): boolean {
  const outletId = useOutletId();
  return API_MOCK || outletId !== "";
}

function useIntentKey(prefix: string) {
  const current = useRef<IntentKey | null>(null);
  const lastFailure = useRef<CorrectionFailureKind | null>(null);
  // True between a send and its answer: an override that fails before the
  // correction is sent recorded nothing and must not lock the form.
  const sent = useRef(false);
  const [uncertain, setUncertain] = useState(false);
  return {
    /** The last send ended with an unknown result; the form stays locked. */
    uncertain,
    keyFor(input: unknown): string {
      sent.current = true;
      current.current = nextIdempotencyKey(
        current.current,
        JSON.stringify(input),
        lastFailure.current,
        () => `${prefix}:${globalThis.crypto.randomUUID()}`,
      );
      return current.current.key;
    },
    /**
     * A failed send. UNCERTAIN keeps the key and locks the form; a definite
     * rejection drops the key so the next try is a new intent. Returns true
     * when the result is uncertain.
     */
    fail(error: unknown): boolean {
      if (!sent.current) return false;
      sent.current = false;
      const kind =
        error instanceof ApiError
          ? correctionFailureKind(error.status)
          : "uncertain";
      lastFailure.current = kind === "uncertain" ? kind : null;
      if (kind === "rejected") current.current = null;
      setUncertain(kind === "uncertain");
      return kind === "uncertain";
    },
    clear() {
      current.current = null;
      lastFailure.current = null;
      sent.current = false;
      setUncertain(false);
    },
  };
}

// ---- Reads -----------------------------------------------------------------

export function useCorrectionOrder(orderId: string) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...correctionOrderQuery(outletId, orderId),
    enabled: ready && orderId !== "",
  });
}

/** The discount threshold the screen compares a proposed discount against. */
export function useCorrectionPolicy() {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({ ...correctionPolicyQuery(outletId), enabled: ready });
}

/** The rendered receipt; idle while the order has no receipt yet. */
export function useReceiptDocument(receiptId: string | null) {
  const outletId = useOutletId();
  const ready = useReady();
  return useQuery({
    ...receiptDocumentQuery(outletId, receiptId ?? ""),
    enabled: ready && receiptId !== null,
  });
}

export function useApproverOptions(action?: OverrideAction) {
  return useSupervisorOptions(action);
}

// ---- Approval --------------------------------------------------------------

/** What the supervisor typed on the approval dialog, plus what it approves. */
export type ApprovalRequest = {
  approverUserId: string;
  pin: string;
  reason: string;
  valueIdr: number;
  objectType: "order" | "order_item";
  objectId: string;
};

async function approve(
  outletId: string,
  action: Extract<OverrideAction, "discount" | "void" | "refund">,
  request: ApprovalRequest,
): Promise<CorrectionApproval> {
  const result = await requestOverride(outletId, { action, ...request });
  return { approvedBy: request.approverUserId, overrideId: result.overrideId };
}

function refreshOrder(
  queryClient: QueryClient,
  outletId: string,
  orderId: string,
) {
  void queryClient.invalidateQueries({
    queryKey: posCorrectionKeys.order(outletId, orderId),
  });
}

// ---- Corrections -----------------------------------------------------------

/**
 * Manual discount. Without `approval` the order sends no override (the amount
 * is under the outlet's threshold); the server refuses an unapproved discount
 * above it, so the screen's own check is a convenience, not the rule.
 */
export function useApplyDiscount() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("pos-discount");
  const mutation = useMutation({
    mutationFn: async (variables: {
      input: Omit<ApplyDiscountInput, "approval">;
      approval?: ApprovalRequest;
    }) => {
      const approval = variables.approval
        ? await approve(outletId, "discount", variables.approval)
        : undefined;
      return applyManualDiscount(
        outletId,
        { ...variables.input, ...(approval ? { approval } : {}) },
        intent.keyFor(variables.input),
      );
    },
    onSuccess: (_order, variables) => {
      intent.clear();
      refreshOrder(queryClient, outletId, variables.input.orderId);
    },
    onError: (error, variables) => {
      if (intent.fail(error))
        refreshOrder(queryClient, outletId, variables.input.orderId);
    },
  });
  return { ...mutation, uncertain: intent.uncertain };
}

export function useVoidItem() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("pos-void");
  return useMutation({
    mutationFn: async (variables: {
      input: Omit<VoidItemInput, "approval">;
      approval: ApprovalRequest;
    }) => {
      const approval = await approve(outletId, "void", variables.approval);
      return voidOrderItem(
        outletId,
        { ...variables.input, approval },
        intent.keyFor(variables.input),
      );
    },
    onSuccess: (_order, variables) => {
      intent.clear();
      refreshOrder(queryClient, outletId, variables.input.orderId);
    },
  });
}

export function useRefund() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("pos-refund");
  const mutation = useMutation({
    mutationFn: async (variables: {
      input: Omit<RefundInput, "approval">;
      approval: ApprovalRequest;
    }) => {
      const approval = await approve(outletId, "refund", variables.approval);
      return refundOrder(
        outletId,
        { ...variables.input, approval },
        intent.keyFor(variables.input),
      );
    },
    onSuccess: (_refund, variables) => {
      intent.clear();
      refreshOrder(queryClient, outletId, variables.input.orderId);
    },
    onError: (error, variables) => {
      if (intent.fail(error))
        refreshOrder(queryClient, outletId, variables.input.orderId);
    },
  });
  return { ...mutation, uncertain: intent.uncertain };
}

// ---- Receipt ---------------------------------------------------------------

/** Issue or reprint the receipt; each tap after a success is a new print. */
export function usePrintReceipt() {
  const outletId = useOutletId();
  const queryClient = useQueryClient();
  const intent = useIntentKey("pos-receipt");
  return useMutation({
    mutationFn: async (orderId: string) => {
      // P2: the reprint goes to this tablet's printer too. The width is part
      // of the ask, so a changed printer is a new request, not a replay.
      const printer = readTabletPrinter();
      const paperWidth = paperWidthOf(printer);
      const result = await printOrderReceipt(
        outletId,
        orderId,
        intent.keyFor(`${orderId}:${paperWidth ?? "none"}`),
        paperWidth,
      );
      const { outcome } = deliverToTabletPrinter(result.print, printer);
      return { ...result, tabletPrint: outcome };
    },
    onSuccess: (_result, orderId) => {
      intent.clear();
      refreshOrder(queryClient, outletId, orderId);
      void queryClient.invalidateQueries({
        queryKey: [...posCorrectionKeys.all, outletId, "receipt"],
      });
    },
  });
}
