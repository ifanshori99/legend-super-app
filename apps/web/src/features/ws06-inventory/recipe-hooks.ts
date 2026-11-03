// The only way the recipe and production components touch data. Kept beside
// the other inventory hook modules so parallel WS-06 FE beads never edited one
// file. Every write invalidates the lists it can change; a production batch
// also posts stock movements, so the stock screens refresh too.
import * as React from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getRecipe,
  listProductionOrders,
  listRecipes,
  listStockBalances,
  listStockLedger,
  type UomConversion,
} from "@starter/shared/inventory";
import { conversionsQuery } from "./queries";
import * as api from "./recipe-api";
import { RECIPE_BRAND_ID, RECIPE_LIST_LIMIT } from "./recipe-lib";
import {
  productionOrdersQuery,
  productionOutletsQuery,
  recipeQuery,
  recipesQuery,
} from "./recipe-queries";
import { INVENTORY_OUTLET_ID } from "./outlet";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

// ---- Reads ---------------------------------------------------------------

export function useRecipes() {
  return useQuery(
    recipesQuery({ brandId: RECIPE_BRAND_ID, limit: RECIPE_LIST_LIMIT }),
  );
}

export function useRecipe(recipeId: string) {
  return useQuery({
    ...recipeQuery({ recipeId }),
    enabled: recipeId !== "",
  });
}

export function useProductionOrders() {
  return useQuery(
    productionOrdersQuery({
      outletId: INVENTORY_OUTLET_ID,
      limit: RECIPE_LIST_LIMIT,
    }),
  );
}

export function useProductionOutlets() {
  return useQuery(productionOutletsQuery());
}

/**
 * Conversions for every distinct component item on the BOM, so the editor can
 * show the converted base quantity and value a line without a request per
 * render. The endpoint is per item, so this fans out over the distinct ids.
 */
export function useComponentConversions(itemIds: readonly string[]) {
  const ids = React.useMemo(
    () => [...new Set(itemIds.filter((id) => id !== ""))].sort(),
    [itemIds],
  );
  return useQueries({
    queries: ids.map((itemId) => ({
      ...conversionsQuery({ itemId }),
      enabled: itemId !== "",
    })),
    combine: (results) => {
      const byItem = new Map<string, readonly UomConversion[]>();
      ids.forEach((itemId, index) => {
        const data = results[index]?.data;
        if (data !== undefined) byItem.set(itemId, data.data);
      });
      return {
        byItem,
        pending: results.some((result) => result.isPending),
        failed: results.some((result) => result.isError),
      };
    },
  });
}

// ---- Mutations -----------------------------------------------------------

export function useCreateRecipe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      body: Parameters<typeof api.createRecipe>[0];
      idempotencyKey: string;
    }) => api.createRecipe(variables.body, variables.idempotencyKey),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [listRecipes.id] }),
  });
}

export function useCreateRecipeVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      recipeId: string;
      body: Parameters<typeof api.createRecipeVersion>[1];
      idempotencyKey: string;
    }) =>
      api.createRecipeVersion(
        { recipeId: variables.recipeId },
        variables.body,
        variables.idempotencyKey,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [listRecipes.id] }),
        queryClient.invalidateQueries({ queryKey: [getRecipe.id] }),
      ]),
  });
}

export function useCreateProductionOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      body: Parameters<typeof api.createProductionOrder>[0];
      idempotencyKey: string;
    }) => api.createProductionOrder(variables.body, variables.idempotencyKey),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: [listProductionOrders.id],
      }),
  });
}

export function useProductionTransition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      productionOrderId: string;
      body: Parameters<typeof api.transitionProductionOrder>[1];
      idempotencyKey: string;
    }) =>
      api.transitionProductionOrder(
        { productionOrderId: variables.productionOrderId },
        variables.body,
        variables.idempotencyKey,
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [listProductionOrders.id],
        }),
        // Completion posts the recipe's stock movements and refreshes costs
        // (INV-02/INV-04), so the stock and recipe screens reload too.
        queryClient.invalidateQueries({
          queryKey: [listStockBalances.id],
        }),
        queryClient.invalidateQueries({
          queryKey: [listStockLedger.id],
        }),
        queryClient.invalidateQueries({ queryKey: [listRecipes.id] }),
      ]),
  });
}

// ---- Attempt keys --------------------------------------------------------

/**
 * One idempotency key per business attempt (Opus review, legend-1j7): a retry
 * of the same payload after a timeout or network drop must reuse its key, or
 * the API creates a second document. A changed payload is a new attempt and
 * gets a new key; success clears it. Copied from purchasing-page.tsx so the
 * recipe screens share the reviewed behaviour (legend-w0v).
 */
export function useAttemptKey(): {
  keyFor: (payload: unknown) => string;
  settle: () => void;
} {
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
