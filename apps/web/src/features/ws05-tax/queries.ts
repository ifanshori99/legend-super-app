// Query keys and options for the tax screens. Every key starts with the
// endpoint id (`endpointQueryOptions`), so one
// `invalidateQueries({ queryKey: [endpoint.id] })` refreshes every cached page
// of that endpoint (docs/frontend.md).
import { queryOptions } from "@tanstack/react-query";
import type {
  AnyEndpoint,
  EndpointInput,
  EndpointOutput,
} from "@starter/shared/api";
import { listCategories, listItems } from "@starter/shared/menu";
import { getFloorBoard } from "@starter/shared/qr-order";
import { orgEndpoints } from "@starter/shared/platform";
import {
  getPbjtMonthlyRecap,
  listServiceChargeRules,
  listTaxRuleConflicts,
  listTaxRules,
  listTaxSettings,
} from "@starter/shared/tax";
import {
  callEndpoint,
  endpointQueryKey,
  endpointQueryOptions,
} from "@/lib/api/endpoint";
import { collectAllPages } from "../ws03-menu/pages.ts";

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
    ...endpointQueryOptions(getFloorBoard, { params: { outletId }, query: {} }),
    staleTime: 5 * 60_000,
    retry: false,
  };
}

/**
 * Menu categories and items for the rule's category/item targets. Read from
 * the menu contract, one page of 100 (PAGE_LIMIT_MAX); a failure never blocks
 * the rule editor, which keeps the targets the version already carries.
 */
export const taxMenuCategoriesQuery = () => ({
  ...endpointQueryOptions(listCategories, { query: { limit: 100 } }),
  staleTime: 5 * 60_000,
  retry: false,
});

export const taxMenuItemsQuery = () => ({
  ...endpointQueryOptions(listItems, { query: { limit: 100, sort: "name" } }),
  staleTime: 5 * 60_000,
  retry: false,
});

/**
 * Every published rule version, all pages. The "last food and beverage rule"
 * warning (legend-d5pz) must not depend on the first 100 rows of the list.
 * Keyed under the endpoint id, so a rule write that invalidates
 * `[listTaxRules.id]` refreshes it too.
 */
export const taxPublishedRulesAllQuery = () => {
  const query = { limit: TAX_PAGE_SIZE, status: "published" as const };
  type Page = EndpointOutput<typeof listTaxRules>;
  return queryOptions({
    queryKey: [
      ...endpointQueryKey(listTaxRules, { query }),
      "all-pages",
    ] as const,
    queryFn: ({ signal }) =>
      collectAllPages<Page["data"][number], Page>((cursor) =>
        callEndpoint(listTaxRules, { query: { ...query, cursor } }, { signal }),
      ),
  });
};
