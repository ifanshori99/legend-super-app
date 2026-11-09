// Hooks for the facility admin screens (docs/frontend.md "Custom hooks").
// Components never call api.ts or useQuery directly.
//
// Cache policy: each mutation patches the cached config with the response
// entity — the same shape the real API returns. A list row follows the updated
// facility by merging it over the row, so the list-only counts (areaCount,
// unitCount, activeUnitCount, productCount) survive. In mock mode
// GET /api/facility/config answers from the same store the writes change (bead
// legend-wbwl), so a refetch keeps the edits.
//
// Writes follow bead legend-6jms: an update sends the `updatedAt` of the row as
// the editor saw it when it opened (`expectedUpdatedAt`, passed by the caller;
// never read from the cache at save time, which a refetch may have replaced
// while the form still shows the old values). The API answers 412 when another
// admin saved first, and the config is refetched so the form shows the new
// values (the General tab resyncs its form from the refetched row after a
// conflict, see general-tab.tsx), and a create sends one `idempotencyKey` per
// attempt, reused while the same body is retried so a double submit creates one
// row.
import { useRef } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { CursorPage } from "@starter/shared/core";
import type {
  Facility,
  FacilityConfig,
  FacilityListItem,
} from "@starter/shared/facility";
import { ApiError } from "@/lib/api/errors.ts";
import * as api from "./api.ts";
import { mergeFacilityRow } from "./admin-conflict.ts";
import {
  facilityAdminKeys,
  facilityConfigQuery,
  facilitiesListQuery,
  inventoryItemsQuery,
  menuItemsQuery,
} from "./queries.ts";

export function useFacilities(
  input: Parameters<typeof facilitiesListQuery>[0],
) {
  return useQuery(facilitiesListQuery(input));
}

export function useFacilityConfig(facilityId: string) {
  return useQuery(facilityConfigQuery(facilityId));
}

export function useMenuItemOptions(enabled = true) {
  return useQuery({ ...menuItemsQuery(), enabled });
}

export function useInventoryItemOptions(enabled = true) {
  return useQuery({ ...inventoryItemsQuery(), enabled });
}

function patchConfig(
  queryClient: QueryClient,
  facilityId: string,
  update: (config: FacilityConfig) => FacilityConfig,
) {
  queryClient.setQueryData<FacilityConfig>(
    facilityAdminKeys.config(facilityId),
    (current) => (current ? update(current) : current),
  );
}

function patchFacilityRow(queryClient: QueryClient, facility: Facility) {
  queryClient.setQueriesData<CursorPage<FacilityListItem>>(
    { queryKey: facilityAdminKeys.lists() },
    (page) => mergeFacilityRow(page, facility),
  );
}

/** After a 409/412 the cache is stale: refetch so the form shows what won. */
function refetchOnConflict(
  queryClient: QueryClient,
  facilityId: string,
  error: unknown,
) {
  if (
    error instanceof ApiError &&
    (error.status === 409 || error.status === 412)
  ) {
    void queryClient.invalidateQueries({
      queryKey: facilityAdminKeys.config(facilityId),
    });
    void queryClient.invalidateQueries({ queryKey: facilityAdminKeys.lists() });
  }
}

/**
 * One idempotency key per create attempt. The key is kept while the same body
 * is sent again (double click, retry after a network error) and dropped once
 * the create succeeded.
 */
function useCreateKey() {
  const attempt = useRef<{ body: string; key: string } | null>(null);
  return {
    keyFor(body: unknown): string {
      const serialized = JSON.stringify(body);
      if (attempt.current?.body !== serialized)
        attempt.current = { body: serialized, key: crypto.randomUUID() };
      return attempt.current.key;
    },
    done() {
      attempt.current = null;
    },
  };
}

export function useUpdateFacility(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      body: api.UpdateFacilityBody;
      expectedUpdatedAt: string;
    }) => api.updateFacility(facilityId, input.body, input.expectedUpdatedAt),
    onSuccess: (facility) => {
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        facility,
      }));
      patchFacilityRow(queryClient, facility);
    },
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useCreateArea(facilityId: string) {
  const queryClient = useQueryClient();
  const keys = useCreateKey();
  return useMutation({
    mutationFn: (body: api.CreateAreaBody) =>
      api.createArea(body, keys.keyFor(body)),
    onSuccess: (area) => {
      keys.done();
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        areas: [...config.areas, area],
      }));
    },
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useUpdateArea(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      areaId: string;
      body: api.UpdateAreaBody;
      expectedUpdatedAt: string;
    }) => api.updateArea(input.areaId, input.body, input.expectedUpdatedAt),
    onSuccess: (area) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        areas: config.areas.map((row) => (row.id === area.id ? area : row)),
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useCreateUnit(facilityId: string) {
  const queryClient = useQueryClient();
  const keys = useCreateKey();
  return useMutation({
    mutationFn: (body: api.CreateUnitBody) =>
      api.createUnit(body, keys.keyFor(body)),
    onSuccess: (unit) => {
      keys.done();
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        units: [...config.units, unit],
      }));
    },
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useUpdateUnitConfig(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      unitId: string;
      body: api.UpdateUnitConfigBody;
      expectedUpdatedAt: string;
    }) =>
      api.updateUnitConfig(input.unitId, input.body, input.expectedUpdatedAt),
    onSuccess: (unit) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        units: config.units.map((row) => (row.id === unit.id ? unit : row)),
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useCreateProduct(facilityId: string) {
  const queryClient = useQueryClient();
  const keys = useCreateKey();
  return useMutation({
    mutationFn: (body: api.CreateProductBody) =>
      api.createProduct(body, keys.keyFor(body)),
    onSuccess: (product) => {
      keys.done();
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        products: [...config.products, product],
      }));
    },
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useUpdateProduct(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      productId: string;
      body: api.UpdateProductBody;
      expectedUpdatedAt: string;
    }) =>
      api.updateProduct(input.productId, input.body, input.expectedUpdatedAt),
    onSuccess: (product) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        products: config.products.map((row) =>
          row.id === product.id ? product : row,
        ),
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useCreateAddon(facilityId: string) {
  const queryClient = useQueryClient();
  const keys = useCreateKey();
  return useMutation({
    mutationFn: (body: api.CreateAddonBody) =>
      api.createAddon(body, keys.keyFor(body)),
    onSuccess: (addon) => {
      keys.done();
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        addons: [...config.addons, addon],
      }));
    },
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useUpdateAddon(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      addonId: string;
      body: api.UpdateAddonBody;
      expectedUpdatedAt: string;
    }) => api.updateAddon(input.addonId, input.body, input.expectedUpdatedAt),
    onSuccess: (addon) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        addons: config.addons.map((row) => (row.id === addon.id ? addon : row)),
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function usePutRule(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      ruleId: string;
      body: api.PutEntitlementRuleBody;
      expectedUpdatedAt: string | null;
    }) => api.putRule(input.ruleId, input.body, input.expectedUpdatedAt),
    onSuccess: (rule) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        entitlementRules: config.entitlementRules.some(
          (row) => row.id === rule.id,
        )
          ? config.entitlementRules.map((row) =>
              row.id === rule.id ? rule : row,
            )
          : [...config.entitlementRules, rule],
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useCreatePlan(facilityId: string) {
  const queryClient = useQueryClient();
  const keys = useCreateKey();
  return useMutation({
    mutationFn: (body: api.CreatePlanBody) =>
      api.createPlan(body, keys.keyFor(body)),
    onSuccess: (plan) => {
      keys.done();
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        subscriptionPlans: [...config.subscriptionPlans, plan],
      }));
    },
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function useUpdatePlan(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      planId: string;
      body: api.UpdatePlanBody;
      expectedUpdatedAt: string;
    }) => api.updatePlan(input.planId, input.body, input.expectedUpdatedAt),
    onSuccess: (plan) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        subscriptionPlans: config.subscriptionPlans.map((row) =>
          row.id === plan.id ? plan : row,
        ),
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}

export function usePutWifiPolicy(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      policyId: string;
      body: api.PutWifiPolicyBody;
      expectedUpdatedAt: string | null;
    }) =>
      api.putWifiPolicy(input.policyId, input.body, input.expectedUpdatedAt),
    onSuccess: (policy) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        wifiPolicies: config.wifiPolicies.some((row) => row.id === policy.id)
          ? config.wifiPolicies.map((row) =>
              row.id === policy.id ? policy : row,
            )
          : [...config.wifiPolicies, policy],
      })),
    onError: (error) => refetchOnConflict(queryClient, facilityId, error),
  });
}
