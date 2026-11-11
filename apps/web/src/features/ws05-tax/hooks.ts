// The only way components touch tax data: queries keep their endpoint keys;
// every write invalidates the list it changes (docs/frontend.md "Custom
// hooks").
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  listServiceChargeRules,
  listTaxRuleConflicts,
  listTaxRules,
  listTaxSettings,
} from "@starter/shared/tax";
import * as api from "./api";
import {
  defaultRecapQuery,
  floorZonesQuery,
  serviceChargeRulesDefaultQuery,
  taxMenuCategoriesQuery,
  taxMenuItemsQuery,
  taxOutletsQuery,
  taxRuleConflictsDefaultQuery,
  taxRulesDefaultQuery,
  taxSettingsDefaultQuery,
} from "./queries";

function useInvalidate() {
  const queryClient = useQueryClient();
  return (endpoints: readonly AnyEndpoint[]) =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

function useTaxMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  invalidate: readonly AnyEndpoint[],
) {
  const refresh = useInvalidate();
  return useMutation({
    mutationFn,
    onSuccess: () => refresh(invalidate),
  });
}

// ---- Reads -----------------------------------------------------------------

export function useTaxRules() {
  return useQuery(taxRulesDefaultQuery());
}

/** Published rules that tie in the engine; best effort, never blocks the page. */
export function useTaxRuleConflicts() {
  return useQuery(taxRuleConflictsDefaultQuery());
}

export function useTaxOutlets() {
  return useQuery(taxOutletsQuery());
}

export function useTaxMenuCategories() {
  return useQuery(taxMenuCategoriesQuery());
}

export function useTaxMenuItems() {
  return useQuery(taxMenuItemsQuery());
}

export function useServiceChargeRules() {
  return useQuery(serviceChargeRulesDefaultQuery());
}

export function useTaxSettings() {
  return useQuery(taxSettingsDefaultQuery());
}

/** PBJT recap of one month; the period comes from the report URL. */
export function usePbjtRecap(outletId: string | undefined, period: string) {
  return useQuery({
    ...defaultRecapQuery(outletId ?? "", period),
    enabled: Boolean(outletId),
  });
}

/** Floor zones for the service-charge scope picker (best effort). */
export function useFloorZones(outletId: string | undefined) {
  return useQuery({
    ...floorZonesQuery(outletId ?? ""),
    enabled: Boolean(outletId),
  });
}

// ---- Writes ----------------------------------------------------------------

export function useCreateTaxRule() {
  return useTaxMutation(api.createTaxRule, [
    listTaxRules,
    listTaxRuleConflicts,
  ]);
}

export function useUpdateTaxRule() {
  return useTaxMutation(
    (variables: {
      params: Parameters<typeof api.updateTaxRule>[0];
      body: Parameters<typeof api.updateTaxRule>[1];
    }) => api.updateTaxRule(variables.params, variables.body),
    [listTaxRules, listTaxRuleConflicts],
  );
}

export function usePublishTaxRule() {
  return useTaxMutation(
    (variables: {
      params: Parameters<typeof api.publishTaxRule>[0];
      idempotencyKey: string;
    }) =>
      api.publishTaxRule(variables.params, {
        idempotencyKey: variables.idempotencyKey,
      }),
    [listTaxRules, listTaxRuleConflicts],
  );
}

export function useArchiveTaxRule() {
  return useTaxMutation(
    (variables: { params: Parameters<typeof api.archiveTaxRule>[0] }) =>
      api.archiveTaxRule(variables.params),
    [listTaxRules, listTaxRuleConflicts],
  );
}

export function useCreateServiceChargeRule() {
  return useTaxMutation(api.createServiceChargeRule, [listServiceChargeRules]);
}

export function useUpdateServiceChargeRule() {
  return useTaxMutation(
    (variables: {
      params: Parameters<typeof api.updateServiceChargeRule>[0];
      body: Parameters<typeof api.updateServiceChargeRule>[1];
    }) => api.updateServiceChargeRule(variables.params, variables.body),
    [listServiceChargeRules],
  );
}

export function usePublishServiceChargeRule() {
  return useTaxMutation(
    (variables: {
      params: Parameters<typeof api.publishServiceChargeRule>[0];
      idempotencyKey: string;
    }) =>
      api.publishServiceChargeRule(variables.params, {
        idempotencyKey: variables.idempotencyKey,
      }),
    [listServiceChargeRules],
  );
}

export function useCreateTaxSettings() {
  return useTaxMutation(api.createTaxSettings, [listTaxSettings]);
}

export function useUpdateTaxSettings() {
  return useTaxMutation(
    (variables: {
      params: Parameters<typeof api.updateTaxSettings>[0];
      body: Parameters<typeof api.updateTaxSettings>[1];
    }) => api.updateTaxSettings(variables.params, variables.body),
    [listTaxSettings],
  );
}

export function useArchiveTaxSettings() {
  return useTaxMutation(
    (variables: { params: Parameters<typeof api.archiveTaxSettings>[0] }) =>
      api.archiveTaxSettings(variables.params),
    [listTaxSettings],
  );
}

export function usePublishTaxSettings() {
  return useTaxMutation(
    (variables: {
      params: Parameters<typeof api.publishTaxSettings>[0];
      idempotencyKey: string;
    }) =>
      api.publishTaxSettings(variables.params, {
        idempotencyKey: variables.idempotencyKey,
      }),
    [listTaxSettings],
  );
}
