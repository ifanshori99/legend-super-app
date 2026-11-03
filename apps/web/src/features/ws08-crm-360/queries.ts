// Query keys and options for the CRM back office. Keyed by the endpoint id
// through `endpointQueryOptions`, so `invalidateQueries({ queryKey:
// [endpoint.id] })` refreshes every screen that reads the same rows.
import {
  keepPreviousData,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  getCustomer360,
  listCustomerPoints,
  listCustomers,
  listFeedback,
  listLoyaltyTiers,
  listSegments,
  previewSegment,
  type SegmentDefinition,
  type SegmentPreview,
} from "@starter/shared/crm";
import { listItems } from "@starter/shared/menu";
import { orgEndpoints } from "@starter/shared/platform";
import { endpointQueryKey, endpointQueryOptions } from "@/lib/api/endpoint";
import {
  fetchCustomer360,
  fetchMenuItems,
  fetchOutlets,
  fetchSegmentPreview,
} from "./api";

type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

export const customersQuery = (query: Query<typeof listCustomers>) =>
  endpointQueryOptions(listCustomers, { query });

export const customer360Query = (customerProfileId: string) =>
  queryOptions({
    queryKey: endpointQueryKey(getCustomer360, {
      params: { customerProfileId },
    }),
    // The API caller unwraps `{ data }`; the screen reads the Customer 360
    // object directly (keeps PII out of SSR, docs/frontend.md "Typed
    // endpoints and mock mode").
    queryFn: ({ signal }) => fetchCustomer360(customerProfileId, signal),
  });

export const customerPointsQuery = (
  customerProfileId: string,
  query: Query<typeof listCustomerPoints>,
) =>
  endpointQueryOptions(listCustomerPoints, {
    params: { customerProfileId },
    query,
  });

export const segmentsQuery = (query: Query<typeof listSegments>) =>
  endpointQueryOptions(listSegments, { query });

export const feedbackQuery = (query: Query<typeof listFeedback>) =>
  endpointQueryOptions(listFeedback, { query });

/** The loyalty tier ladder, for tier names and the tier rule picker. */
export const tiersQuery = () => endpointQueryOptions(listLoyaltyTiers);

/** Menu catalog for the favorite-item rule (WS-03 master menu). */
export const menuCatalogQuery = () =>
  queryOptions({
    queryKey: [listItems.id, "crm360-picker"],
    queryFn: ({ signal }) => fetchMenuItems(signal),
  });

/** Outlet catalog for the outlet rule (WS-01 org). */
export const outletCatalogQuery = () =>
  queryOptions({
    queryKey: [orgEndpoints.listOutlets.id, "crm360-picker"],
    queryFn: ({ signal }) => fetchOutlets(signal),
  });

/**
 * Live segment preview. A POST endpoint, so it cannot use
 * `endpointQueryOptions`; the definition is the key, and an incomplete
 * definition skips the request.
 */
export const segmentPreviewQuery = (definition: SegmentDefinition | null) =>
  queryOptions<SegmentPreview>({
    queryKey: [previewSegment.id, definition],
    queryFn:
      definition === null
        ? skipToken
        : ({ signal }) => fetchSegmentPreview({ definition }, signal),
    staleTime: 30_000,
    // Keep the last count on screen while the next definition is counted, so
    // each rule edit does not flash the skeleton.
    placeholderData: keepPreviousData,
  });
