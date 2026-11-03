// Query keys and queryOptions for the receiving screens (bead legend-xkk). Keys
// stay `[endpoint.id, input]` so invalidation by endpoint id refreshes every
// page; the query functions go through receiving-api.ts, which registers the
// feature's mock handlers before the first request in mock mode (the eager
// handler glob does not see `receiving-mock.ts`).
import { queryOptions } from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getGoodsReceipt,
  getPettyPurchase,
  getPettyPurchasePolicy,
  getPurchaseReturn,
  getSupplierInvoice,
  getSupplierPayment,
  listGoodsReceipts,
  listPettyPurchases,
  listPurchaseReturns,
  listSupplierInvoices,
  listSupplierPayments,
} from "@starter/shared/inventory";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./receiving-api.ts";

type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const goodsReceiptsQuery = (query: Query<typeof listGoodsReceipts>) =>
  queryOptions({
    queryKey: endpointQueryKey(listGoodsReceipts, { query }),
    queryFn: ({ signal }) => api.fetchGoodsReceipts(query, signal),
  });
export const goodsReceiptQuery = (id: string) => {
  const params: Params<typeof getGoodsReceipt> = { goodsReceiptId: id };
  return queryOptions({
    queryKey: endpointQueryKey(getGoodsReceipt, { params }),
    queryFn: ({ signal }) => api.fetchGoodsReceipt(params, signal),
  });
};
export const supplierInvoicesQuery = (
  query: Query<typeof listSupplierInvoices>,
) =>
  queryOptions({
    queryKey: endpointQueryKey(listSupplierInvoices, { query }),
    queryFn: ({ signal }) => api.fetchSupplierInvoices(query, signal),
  });
export const supplierInvoiceQuery = (id: string) => {
  const params: Params<typeof getSupplierInvoice> = {
    supplierInvoiceId: id,
  };
  return queryOptions({
    queryKey: endpointQueryKey(getSupplierInvoice, { params }),
    queryFn: ({ signal }) => api.fetchSupplierInvoice(params, signal),
  });
};
export const supplierPaymentsQuery = (
  query: Query<typeof listSupplierPayments>,
) =>
  queryOptions({
    queryKey: endpointQueryKey(listSupplierPayments, { query }),
    queryFn: ({ signal }) => api.fetchSupplierPayments(query, signal),
  });
export const supplierPaymentQuery = (id: string) => {
  const params: Params<typeof getSupplierPayment> = {
    supplierPaymentId: id,
  };
  return queryOptions({
    queryKey: endpointQueryKey(getSupplierPayment, { params }),
    queryFn: ({ signal }) => api.fetchSupplierPayment(params, signal),
  });
};
export const purchaseReturnsQuery = (
  query: Query<typeof listPurchaseReturns>,
) =>
  queryOptions({
    queryKey: endpointQueryKey(listPurchaseReturns, { query }),
    queryFn: ({ signal }) => api.fetchPurchaseReturns(query, signal),
  });
export const purchaseReturnQuery = (id: string) => {
  const params: Params<typeof getPurchaseReturn> = { purchaseReturnId: id };
  return queryOptions({
    queryKey: endpointQueryKey(getPurchaseReturn, { params }),
    queryFn: ({ signal }) => api.fetchPurchaseReturn(params, signal),
  });
};
export const pettyPurchasesQuery = (query: Query<typeof listPettyPurchases>) =>
  queryOptions({
    queryKey: endpointQueryKey(listPettyPurchases, { query }),
    queryFn: ({ signal }) => api.fetchPettyPurchases(query, signal),
  });
export const pettyPurchaseQuery = (id: string) => {
  const params: Params<typeof getPettyPurchase> = { pettyPurchaseId: id };
  return queryOptions({
    queryKey: endpointQueryKey(getPettyPurchase, { params }),
    queryFn: ({ signal }) => api.fetchPettyPurchase(params, signal),
  });
};
export const pettyPurchasePolicyQuery = (
  query: Query<typeof getPettyPurchasePolicy>,
) =>
  queryOptions({
    queryKey: endpointQueryKey(getPettyPurchasePolicy, { query }),
    queryFn: ({ signal }) => api.fetchPettyPurchasePolicy(query, signal),
  });
