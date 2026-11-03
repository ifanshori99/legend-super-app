// Query keys and options for the supplier screens (docs/frontend.md "Query
// options and keys"). Keys are `[endpoint.id, input]`, so an invalidation by
// endpoint id refreshes every page of that endpoint. The query functions go
// through ./supplier-api.ts, which registers the feature's mock handlers before
// the first request in mock mode (the eager handler glob does not see
// `supplier-mock.ts`).
import { queryOptions } from "@tanstack/react-query";
import type { BusinessDate } from "@starter/shared/core";
import {
  getSupplier,
  getSupplierPerformance,
  getSupplierPriceHistory,
  listSupplierCatalog,
  listSuppliers,
} from "@starter/shared/inventory";
import { endpointQueryKey } from "@/lib/api/endpoint";
import * as api from "./supplier-api";
import { SUPPLIER_LIST_LIMIT } from "./supplier-lib";

/** "all" leaves the contract filter out; the API defaults to every supplier. */
export type SupplierStatusFilter = "all" | "true" | "false";

export const supplierListQuery = (status: SupplierStatusFilter = "all") => {
  const input = {
    query: {
      limit: SUPPLIER_LIST_LIMIT,
      ...(status === "all" ? {} : { isActive: status }),
    },
  };
  return queryOptions({
    queryKey: endpointQueryKey(listSuppliers, input),
    queryFn: ({ signal }) => api.fetchSuppliers(input.query, signal),
  });
};

export const supplierDetailQuery = (supplierId: string) => {
  const input = { params: { supplierId } };
  return queryOptions({
    queryKey: endpointQueryKey(getSupplier, input),
    queryFn: ({ signal }) => api.fetchSupplierDetail(input.params, signal),
  });
};

export const supplierCatalogQuery = (supplierId: string) => {
  const input = {
    params: { supplierId },
    query: { limit: SUPPLIER_LIST_LIMIT },
  };
  return queryOptions({
    queryKey: endpointQueryKey(listSupplierCatalog, input),
    queryFn: ({ signal }) =>
      api.fetchSupplierCatalog(input.params, input.query, signal),
  });
};

export const supplierPriceHistoryQuery = (
  supplierId: string,
  inventoryItemId: string,
) => {
  const input = {
    params: { supplierId },
    query: { inventoryItemId },
  };
  return queryOptions({
    queryKey: endpointQueryKey(getSupplierPriceHistory, input),
    queryFn: ({ signal }) =>
      api.fetchSupplierPriceHistory(input.params, input.query, signal),
  });
};

export const supplierPerformanceQuery = (
  supplierId: string,
  fromDate: BusinessDate,
  toDate: BusinessDate,
) => {
  const input = {
    params: { supplierId },
    query: { fromDate, toDate },
  };
  return queryOptions({
    queryKey: endpointQueryKey(getSupplierPerformance, input),
    queryFn: ({ signal }) =>
      api.fetchSupplierPerformance(input.params, input.query, signal),
  });
};
