// Query keys and options for the POS correction screens. Every key carries the
// outlet: a cashier who switches outlet must never see another outlet's order,
// policy or receipt from the cache.
import { queryOptions } from "@tanstack/react-query";
import { fetchOrder, fetchPolicy, fetchReceiptDocument } from "./api";

export const posCorrectionKeys = {
  all: ["pos-correction"] as const,
  order: (outletId: string, orderId: string) =>
    ["pos-correction", outletId, "order", orderId] as const,
  policy: (outletId: string) => ["pos-correction", outletId, "policy"] as const,
  receipt: (outletId: string, receiptId: string) =>
    ["pos-correction", outletId, "receipt", receiptId] as const,
};

export const correctionOrderQuery = (outletId: string, orderId: string) =>
  queryOptions({
    queryKey: posCorrectionKeys.order(outletId, orderId),
    queryFn: ({ signal }) => fetchOrder(outletId, orderId, signal),
    retry: false,
  });

export const correctionPolicyQuery = (outletId: string) =>
  queryOptions({
    queryKey: posCorrectionKeys.policy(outletId),
    queryFn: ({ signal }) => fetchPolicy(outletId, signal),
    retry: false,
  });

export const receiptDocumentQuery = (outletId: string, receiptId: string) =>
  queryOptions({
    queryKey: posCorrectionKeys.receipt(outletId, receiptId),
    queryFn: ({ signal }) => fetchReceiptDocument(outletId, receiptId, signal),
    retry: false,
  });
