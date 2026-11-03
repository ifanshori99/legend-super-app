// Hooks for the facility admin screens (docs/frontend.md "Custom hooks").
// Components never call api.ts or useQuery directly.
//
// Cache policy: the mock runtime's GET /api/facility/config always answers from
// the seed fixtures (the handler belongs to features/facility/mock.ts), so an
// invalidate would wipe the admin's edits after every save. Each mutation
// patches the cached config with the response entity instead — the same shape
// the real API returns — and the list row follows the updated facility.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { CursorPage } from "@starter/shared/core";
import type { Facility, FacilityConfig } from "@starter/shared/facility";
import * as api from "./api.ts";
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

/**
 * One config read per facility to derive the list's area/unit counts. The
 * list contract carries only the facility row; a follow-up API bead should
 * return the counts so this N+1 disappears (reported as a follow-up).
 */
export function useFacilityConfigSummaries(facilityIds: readonly string[]) {
  return useQueries({
    queries: facilityIds.map((facilityId) => facilityConfigQuery(facilityId)),
  });
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
  queryClient.setQueriesData<CursorPage<Facility>>(
    { queryKey: facilityAdminKeys.lists() },
    (page) =>
      page
        ? {
            ...page,
            data: page.data.map((row) =>
              row.id === facility.id ? facility : row,
            ),
          }
        : page,
  );
}

export function useUpdateFacility(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.UpdateFacilityBody) =>
      api.updateFacility(facilityId, body),
    onSuccess: (facility) => {
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        facility,
      }));
      patchFacilityRow(queryClient, facility);
    },
  });
}

export function useCreateArea(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreateAreaBody) => api.createArea(body),
    onSuccess: (area) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        areas: [...config.areas, area],
      })),
  });
}

export function useUpdateArea(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { areaId: string; body: api.UpdateAreaBody }) =>
      api.updateArea(input.areaId, input.body),
    onSuccess: (area) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        areas: config.areas.map((row) => (row.id === area.id ? area : row)),
      })),
  });
}

export function useCreateUnit(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreateUnitBody) => api.createUnit(body),
    onSuccess: (unit) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        units: [...config.units, unit],
      })),
  });
}

export function useCreateProduct(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreateProductBody) => api.createProduct(body),
    onSuccess: (product) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        products: [...config.products, product],
      })),
  });
}

export function useUpdateProduct(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { productId: string; body: api.UpdateProductBody }) =>
      api.updateProduct(input.productId, input.body),
    onSuccess: (product) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        products: config.products.map((row) =>
          row.id === product.id ? product : row,
        ),
      })),
  });
}

export function useCreateAddon(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreateAddonBody) => api.createAddon(body),
    onSuccess: (addon) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        addons: [...config.addons, addon],
      })),
  });
}

export function useUpdateAddon(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { addonId: string; body: api.UpdateAddonBody }) =>
      api.updateAddon(input.addonId, input.body),
    onSuccess: (addon) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        addons: config.addons.map((row) => (row.id === addon.id ? addon : row)),
      })),
  });
}

export function usePutRule(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { ruleId: string; body: api.PutEntitlementRuleBody }) =>
      api.putRule(input.ruleId, input.body),
    onSuccess: (rule) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        entitlementRules: config.entitlementRules.map((row) =>
          row.id === rule.id ? rule : row,
        ),
      })),
  });
}

export function useCreatePlan(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: api.CreatePlanBody) => api.createPlan(body),
    onSuccess: (plan) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        subscriptionPlans: [...config.subscriptionPlans, plan],
      })),
  });
}

export function useUpdatePlan(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { planId: string; body: api.UpdatePlanBody }) =>
      api.updatePlan(input.planId, input.body),
    onSuccess: (plan) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        subscriptionPlans: config.subscriptionPlans.map((row) =>
          row.id === plan.id ? plan : row,
        ),
      })),
  });
}

export function usePutWifiPolicy(facilityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { policyId: string; body: api.PutWifiPolicyBody }) =>
      api.putWifiPolicy(input.policyId, input.body),
    onSuccess: (policy) =>
      patchConfig(queryClient, facilityId, (config) => ({
        ...config,
        wifiPolicies: config.wifiPolicies.map((row) =>
          row.id === policy.id ? policy : row,
        ),
      })),
  });
}
