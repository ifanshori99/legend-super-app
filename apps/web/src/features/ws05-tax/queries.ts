// Query keys and options for the tax screens. Every key starts with the
// endpoint id (`endpointQueryOptions`), so one
// `invalidateQueries({ queryKey: [endpoint.id] })` refreshes every cached page
// of that endpoint (docs/frontend.md).
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import { getFloorBoard } from "@starter/shared/qr-order";
import { orgEndpoints } from "@starter/shared/platform";
import {
  getPbjtMonthlyRecap,
  listServiceChargeRules,
  listTaxRuleConflicts,
  listTaxRules,
  listTaxSettings,
} from "@starter/shared/tax";
import { endpointQueryOptions } from "@/lib/api/endpoint";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

/** The rule lists are tenant configuration, not a growing log: one page. */
export const TAX_PAGE_SIZE = 100;

export const taxRulesQuery = (query: Query<typeof listTaxRules>) =>
  endpointQueryOptions(listTaxRules, { query });

export const taxRuleConflictsQuery = (
  query: Query<typeof listTaxRuleConflicts>,
) => endpointQueryOptions(listTaxRuleConflicts, { query });

/** Outlet names for the overlap banner; shares the tenant settings cache entry. */
export const taxOutletsQuery = () =>
  endpointQueryOptions(orgEndpoints.listOutlets, { query: { limit: 100 } });

export const serviceChargeRulesQuery = (
  query: Query<typeof listServiceChargeRules>,
) => endpointQueryOptions(listServiceChargeRules, { query });

export const taxSettingsQuery = (query: Query<typeof listTaxSettings>) =>
  endpointQueryOptions(listTaxSettings, { query });

export function pbjtRecapQuery(query: Query<typeof getPbjtMonthlyRecap>) {
  return endpointQueryOptions(getPbjtMonthlyRecap, { query });
}

const defaultListQuery = { limit: TAX_PAGE_SIZE };

export const taxRulesDefaultQuery = () => taxRulesQuery(defaultListQuery);
export const serviceChargeRulesDefaultQuery = () =>
  serviceChargeRulesQuery(defaultListQuery);
export const taxRuleConflictsDefaultQuery = () => taxRuleConflictsQuery({});
export const taxSettingsDefaultQuery = () => taxSettingsQuery(defaultListQuery);
export const defaultRecapQuery = (outletId: string, period: string) =>
  pbjtRecapQuery({ outletId, period });

/**
 * Zones of the current outlet, for the service-charge scope picker. Read from
 * the floor contract; failures do not block the tax screens (see api.ts).
 */
export function floorZonesQuery(outletId: string) {
  return {
    ...endpointQueryOptions(getFloorBoard, { params: { outletId } }),
    staleTime: 5 * 60_000,
    retry: false,
  };
}
