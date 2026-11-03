// The only way components touch CRM data: queries keep their endpoint keys,
// mutations invalidate every endpoint whose rows a write can change.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  listFeedback,
  listSegments,
  type Feedback,
  type SegmentDefinition,
} from "@starter/shared/crm";
import * as api from "./api";
import {
  customer360Query,
  customerPointsQuery,
  customersQuery,
  feedbackQuery,
  menuCatalogQuery,
  outletCatalogQuery,
  segmentPreviewQuery,
  segmentsQuery,
  tiersQuery,
} from "./queries";

function useInvalidate(endpoints: readonly AnyEndpoint[]) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      endpoints.map((endpoint) =>
        queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
      ),
    );
}

function useInvalidateOnSuccess<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  endpoints: readonly AnyEndpoint[],
) {
  const refresh = useInvalidate(endpoints);
  return useMutation({ mutationFn, onSuccess: () => refresh() });
}

// ---- Reads ----------------------------------------------------------------

export const useCustomers = (query: Parameters<typeof api.fetchCustomers>[0]) =>
  useQuery(customersQuery(query));

export const useCustomer360 = (customerProfileId: string) =>
  useQuery(customer360Query(customerProfileId));

export const useCustomerPoints = (
  customerProfileId: string,
  query: Parameters<typeof api.fetchCustomerPoints>[1],
) => useQuery(customerPointsQuery(customerProfileId, query));

export const useSegments = (query: Parameters<typeof api.fetchSegments>[0]) =>
  useQuery(segmentsQuery(query));

export const useFeedback = (query: Parameters<typeof api.fetchFeedback>[0]) =>
  useQuery(feedbackQuery(query));

export const useTiers = () => useQuery(tiersQuery());

export const useMenuCatalog = () => useQuery(menuCatalogQuery());

export const useOutletCatalog = () => useQuery(outletCatalogQuery());

export const useSegmentPreview = (definition: SegmentDefinition | null) =>
  useQuery(segmentPreviewQuery(definition));

// ---- Writes ---------------------------------------------------------------

export function useCreateSegment() {
  return useInvalidateOnSuccess(
    (body: Parameters<typeof api.createSegment>[0]) => api.createSegment(body),
    [listSegments],
  );
}

export function useUpdateFeedback() {
  return useInvalidateOnSuccess(
    (variables: {
      feedbackId: Feedback["id"];
      action: Parameters<typeof api.updateFeedback>[1]["action"];
    }) =>
      api.updateFeedback(
        { feedbackId: variables.feedbackId },
        { action: variables.action },
      ),
    [listFeedback],
  );
}
