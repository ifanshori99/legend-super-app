// Hooks for the facility admin screens (docs/frontend.md "Custom hooks").
// Components never call api.ts or useQuery directly.
//
// Cache policy: each mutation patches the cached config with the response
// entity — the same shape the real API returns — and the list row follows the
// updated facility. In mock mode GET /api/facility/config answers from the same
// store the writes change (bead legend-wbwl), so a refetch keeps the edits.
//
// Writes follow bead legend-6jms: an update sends the `updatedAt` of the row as
// the cache holds it (`expectedUpdatedAt`; the API answers 409 when another
// admin saved first, and the config is refetched so the form shows the new
// values), and a create sends one `idempotencyKey` per attempt, reused while the
// same body is retried so a double submit creates one row.
import { useRef } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { CursorPage } from "@starter/shared/core";
import type { Facility, FacilityConfig } from "@starter/shared/facility";
import { ApiError } from "@/lib/api/errors.ts";
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

/** The cached config of a facility, the source of every `expectedUpdatedAt`. */
function cachedConfig(queryClient: QueryClient, facilityId: string) {
  return queryClient.getQueryData<FacilityConfig>(
    facilityAdminKeys.config(facilityId),
  );
}

/** The stamp of a row that must exist; without it the editor must reload. */
function requireStamp(row: { updatedAt: string } | undefined): string {
  if (!row)
    throw new ApiError(
      409,
      "FACILITY_CONFIG_STALE",
      "Data belum dimuat atau sudah berubah. Muat ulang lalu coba lagi.",
    );
  return row.updatedAt;
}

/** After a 409 the cache is stale: refetch so the form shows what won. */
function refetchOnConflict(
  queryClient: QueryClient,
  facilityId: string,
  error: unknown,
) {
  if (error instanceof ApiError && error.status === 409) {
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
    mutationFn: (body: api.UpdateFacilityBody) =>
      api.updateFacility(
        facilityId,
        body,
        requireStamp(cachedConfig(queryClient, facilityId)?.facility),
      ),
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
    mutationFn: (input: { areaId: string; body: api.UpdateAreaBody }) =>
      api.updateArea(
        input.areaId,
        input.body,
        requireStamp(
          cachedConfig(queryClient, facilityId)?.areas.find(
            (row) => row.id === input.areaId,
          ),
        ),
      ),
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
    mutationFn: (input: { unitId: string; body: api.UpdateUnitConfigBody }) =>
      api.updateUnitConfig(
        input.unitId,
        input.body,
        requireStamp(
          cachedConfig(queryClient, facilityId)?.units.find(
            (row) => row.id === input.unitId,
          ),
        ),
      ),
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
    mutationFn: (input: { productId: string; body: api.UpdateProductBody }) =>
      api.updateProduct(
        input.productId,
        input.body,
        requireStamp(
          cachedConfig(queryClient, facilityId)?.products.find(
            (row) => row.id === input.productId,
          ),
        ),
      ),
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
    mutationFn: (input: { addonId: string; body: api.UpdateAddonBody }) =>
      api.updateAddon(
        input.addonId,
        input.body,
        requireStamp(
          cachedConfig(queryClient, facilityId)?.addons.find(
            (row) => row.id === input.addonId,
          ),
        ),
      ),
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
    mutationFn: (input: { ruleId: string; body: api.PutEntitlementRuleBody }) =>
      api.putRule(
        input.ruleId,
        input.body,
        // null = the rule is not in the cache, so the editor means to create it.
        cachedConfig(queryClient, facilityId)?.entitlementRules.find(
          (row) => row.id === input.ruleId,
        )?.updatedAt ?? null,
      ),
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
    mutationFn: (input: { planId: string; body: api.UpdatePlanBody }) =>
      api.updatePlan(
        input.planId,
        input.body,
        requireStamp(
          cachedConfig(queryClient, facilityId)?.subscriptionPlans.find(
            (row) => row.id === input.planId,
          ),
        ),
      ),
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
    mutationFn: (input: { policyId: string; body: api.PutWifiPolicyBody }) =>
      api.putWifiPolicy(
        input.policyId,
        input.body,
        // null = the policy is not in the cache, so the editor means to create it.
        cachedConfig(queryClient, facilityId)?.wifiPolicies.find(
          (row) => row.id === input.policyId,
        )?.updatedAt ?? null,
      ),
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
