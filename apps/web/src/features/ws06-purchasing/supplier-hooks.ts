// The only way supplier components touch data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change
// (docs/frontend.md "Custom hooks").
import * as React from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import type { BusinessDate, CursorPage } from "@starter/shared/core";
import {
  createSupplier as createSupplierEndpoint,
  createSupplierCatalogItem as createSupplierCatalogItemEndpoint,
  createSupplierContact as createSupplierContactEndpoint,
  getSupplier,
  getSupplierPerformance,
  getSupplierPriceHistory,
  listSuppliers,
  updateSupplier as updateSupplierEndpoint,
} from "@starter/shared/inventory";
import type { SupplierCatalogItem } from "@starter/shared/inventory";
import * as api from "./supplier-api";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  supplierCatalogQuery,
  supplierDetailQuery,
  supplierListQuery,
  supplierPerformanceQuery,
  supplierPriceHistoryQuery,
  type SupplierStatusFilter,
} from "./supplier-queries";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];

// ---- Reads ---------------------------------------------------------------

export const useSupplierList = (status: SupplierStatusFilter = "all") =>
  useQuery(supplierListQuery(status));

export const useSupplierDetail = (supplierId: string) =>
  useQuery({
    ...supplierDetailQuery(supplierId),
    enabled: Boolean(supplierId),
  });

export const useSupplierCatalog = (supplierId: string) =>
  useQuery({
    ...supplierCatalogQuery(supplierId),
    enabled: Boolean(supplierId),
  });

export const useSupplierPerformance = (
  supplierId: string,
  fromDate: BusinessDate,
  toDate: BusinessDate,
) =>
  useQuery({
    ...supplierPerformanceQuery(supplierId, fromDate, toDate),
    enabled: Boolean(supplierId),
  });

/** One history query per catalog item; the detail screen joins the results. */
export const useSupplierPriceHistories = (
  supplierId: string,
  inventoryItemIds: readonly string[],
) =>
  useQueries({
    queries: inventoryItemIds.map((inventoryItemId) => ({
      ...supplierPriceHistoryQuery(supplierId, inventoryItemId),
      enabled: Boolean(supplierId),
    })),
  });

/** Catalog size per list row (the contract has no supplier list projection). */
export const useSupplierCatalogCounts = (supplierIds: readonly string[]) =>
  useQueries({
    queries: supplierIds.map((supplierId) => supplierCatalogQuery(supplierId)),
  });

// ---- Writes --------------------------------------------------------------

/**
 * One idempotency key per business attempt (same rule as legend-1j7): a retry
 * of the same payload after a timeout reuses its key, so a dropped response
 * cannot create a second supplier, contact or price row. A changed payload is
 * a new attempt; success clears the key.
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

function invalidate(client: QueryClient, endpointIds: readonly string[]) {
  return Promise.all(
    endpointIds.map((endpointId) =>
      client.invalidateQueries({ queryKey: [endpointId] }),
    ),
  );
}

export function useCreateSupplier() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Body<typeof createSupplierEndpoint>) =>
      api.createSupplier(body),
    onSuccess: () => invalidate(client, [listSuppliers.id, getSupplier.id]),
  });
}

export function useUpdateSupplier() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      supplierId: string;
      body: Body<typeof updateSupplierEndpoint>;
    }) => api.updateSupplier({ supplierId: input.supplierId }, input.body),
    onSuccess: () =>
      invalidate(client, [
        getSupplier.id,
        listSuppliers.id,
        getSupplierPerformance.id,
      ]),
  });
}

export function useCreateSupplierContact() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      supplierId: string;
      body: Body<typeof createSupplierContactEndpoint>;
    }) => api.createContact({ supplierId: input.supplierId }, input.body),
    onSuccess: () => invalidate(client, [getSupplier.id, listSuppliers.id]),
  });
}

export function useCreateSupplierCatalogItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      supplierId: string;
      body: Body<typeof createSupplierCatalogItemEndpoint>;
    }) => api.createCatalogItem({ supplierId: input.supplierId }, input.body),
    onSuccess: (result, input) => {
      // The response is the created row: append it to the cached catalog page
      // instead of refetching, so the new price appears immediately. The next
      // read still comes from the API (which returns the same row).
      client.setQueryData<CursorPage<SupplierCatalogItem>>(
        supplierCatalogQuery(input.supplierId).queryKey,
        (current) =>
          current
            ? {
                ...current,
                // A retried create replays the same row; never append twice.
                data: current.data.some((row) => row.id === result.data.id)
                  ? current.data
                  : [...current.data, result.data],
              }
            : current,
      );
      return invalidate(client, [getSupplierPriceHistory.id]);
    },
  });
}
