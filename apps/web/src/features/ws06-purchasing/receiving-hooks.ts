// Reads and writes for the receiving screens (bead legend-xkk). Mutations
// invalidate every endpoint they can change, keyed by the contract endpoint id
// (docs/frontend.md "Typed endpoints and mock mode").
import * as React from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getGoodsReceipt,
  getPettyPurchase,
  getPurchaseOrder,
  getPurchaseReturn,
  getSupplierInvoice,
  getSupplierPayment,
  listGoodsReceipts,
  listPettyPurchases,
  listPurchaseOrders,
  listPurchaseReturns,
  listSupplierInvoices,
  listSupplierPayments,
} from "@starter/shared/inventory";
import * as api from "./receiving-api.ts";
import * as queries from "./receiving-queries.ts";
import { RECEIVING_LIST_LIMIT } from "./receiving-lib.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

/**
 * One idempotency key per business attempt: a retry of the same payload after
 * a timeout or network drop reuses its key, so the API cannot book the same
 * document twice. A changed payload is a new attempt and gets a new key;
 * success clears it (same pattern as purchasing-page.tsx).
 */
export function useAttemptKey() {
  const attempt = React.useRef<{ signature: string; key: string } | null>(null);
  return React.useMemo(
    () => ({
      keyFor(payload: unknown): string {
        const signature = JSON.stringify(payload);
        if (attempt.current?.signature !== signature)
          attempt.current = { signature, key: newIdempotencyKey() };
        return attempt.current.key;
      },
      settle() {
        attempt.current = null;
      },
    }),
    [],
  );
}

export const useGoodsReceipts = (outletId: string) =>
  useQuery({
    ...queries.goodsReceiptsQuery({
      outletId,
      limit: RECEIVING_LIST_LIMIT,
    }),
    enabled: Boolean(outletId),
  });

export const useGoodsReceipt = (id: string) =>
  useQuery({ ...queries.goodsReceiptQuery(id), enabled: Boolean(id) });

/**
 * All receipt lines booked against one PO, including the seeded receipts. The
 * form needs them to know how much of each order line was already accepted
 * (INV-05), and the invoice detail uses them for the accepted column.
 */
export function useReceiptLinesForOrder(
  outletId: string,
  purchaseOrderId: string,
) {
  const list = useQuery({
    ...queries.goodsReceiptsQuery({
      outletId,
      purchaseOrderId,
      limit: RECEIVING_LIST_LIMIT,
    }),
    enabled: Boolean(outletId && purchaseOrderId),
  });
  const ids = list.data?.data.map((receipt) => receipt.id) ?? [];
  const details = useQueries({
    queries: ids.map((id) => queries.goodsReceiptQuery(id)),
  });
  return {
    receipts: list.data?.data ?? [],
    lines: details.flatMap((detail) => detail.data?.data.lines ?? []),
    isPending: list.isPending || details.some((detail) => detail.isPending),
    isError: list.isError || details.some((detail) => detail.isError),
    refetch: () => {
      void list.refetch();
      for (const detail of details) void detail.refetch();
    },
  };
}

export const useSupplierInvoices = (
  query: EndpointInput<typeof listSupplierInvoices>["query"],
) =>
  useQuery({
    ...queries.supplierInvoicesQuery(query),
    enabled: Boolean(query?.outletId),
  });

export const useSupplierInvoice = (id: string) =>
  useQuery({ ...queries.supplierInvoiceQuery(id), enabled: Boolean(id) });

export const useSupplierPayments = (
  query: EndpointInput<typeof listSupplierPayments>["query"],
) => useQuery(queries.supplierPaymentsQuery(query));

export const useSupplierPaymentsForInvoice = (invoiceId: string) =>
  useQuery({
    ...queries.supplierPaymentsQuery({
      supplierInvoiceId: invoiceId,
      limit: RECEIVING_LIST_LIMIT,
    }),
    enabled: Boolean(invoiceId),
  });

export const usePurchaseReturns = (outletId: string) =>
  useQuery({
    ...queries.purchaseReturnsQuery({
      outletId,
      limit: RECEIVING_LIST_LIMIT,
    }),
    enabled: Boolean(outletId),
  });

export const usePurchaseReturn = (id: string) =>
  useQuery({ ...queries.purchaseReturnQuery(id), enabled: Boolean(id) });

export const usePettyPurchases = (outletId: string) =>
  useQuery({
    ...queries.pettyPurchasesQuery({
      outletId,
      limit: RECEIVING_LIST_LIMIT,
    }),
    enabled: Boolean(outletId),
  });

export const usePettyPurchase = (id: string) =>
  useQuery({ ...queries.pettyPurchaseQuery(id), enabled: Boolean(id) });

export const usePettyPurchasePolicy = (outletId: string) =>
  useQuery({
    ...queries.pettyPurchasePolicyQuery({ outletId }),
    enabled: Boolean(outletId),
  });

function useInvalidatingMutation<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  endpoints: readonly AnyEndpoint[],
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () =>
      Promise.all(
        endpoints.map((endpoint) =>
          client.invalidateQueries({ queryKey: [endpoint.id] }),
        ),
      ),
  });
}

export const useCreateGoodsReceipt = () =>
  useInvalidatingMutation(api.createGoodsReceipt, [
    listGoodsReceipts,
    getGoodsReceipt,
    listPurchaseOrders,
    getPurchaseOrder,
  ]);

export const useCreateSupplierInvoice = () =>
  useInvalidatingMutation(api.createSupplierInvoice, [
    listSupplierInvoices,
    getSupplierInvoice,
    getPurchaseOrder,
  ]);

export const useRunSupplierInvoiceMatch = () =>
  useInvalidatingMutation(api.runSupplierInvoiceMatch, [
    listSupplierInvoices,
    getSupplierInvoice,
  ]);

export const useCreateSupplierPayment = () =>
  useInvalidatingMutation(api.createSupplierPayment, [
    listSupplierPayments,
    getSupplierPayment,
    listSupplierInvoices,
    getSupplierInvoice,
  ]);

export const useTransitionSupplierPayment = () =>
  useInvalidatingMutation(api.transitionSupplierPayment, [
    listSupplierPayments,
    getSupplierPayment,
    listSupplierInvoices,
    getSupplierInvoice,
  ]);

export const useCreatePurchaseReturn = () =>
  useInvalidatingMutation(api.createPurchaseReturn, [
    listPurchaseReturns,
    getPurchaseReturn,
    listGoodsReceipts,
    getGoodsReceipt,
  ]);

export const useCreatePettyPurchase = () =>
  useInvalidatingMutation(api.createPettyPurchase, [
    listPettyPurchases,
    getPettyPurchase,
  ]);
