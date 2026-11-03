// The only way components touch campaign data: queries keep their endpoint
// keys, mutations invalidate every endpoint whose rows a write can change.
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AnyEndpoint } from "@starter/shared/api";
import {
  getCampaignResults,
  listCampaigns,
  type Campaign,
  type CampaignStatus,
  type SegmentDefinition,
} from "@starter/shared/crm";
import * as api from "./api";
import {
  campaignResultsQuery,
  campaignsQuery,
  segmentPreviewQuery,
  segmentsQuery,
} from "./queries";

function useInvalidateOnSuccess<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
  endpoints: readonly AnyEndpoint[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all(
        endpoints.map((endpoint) =>
          queryClient.invalidateQueries({ queryKey: [endpoint.id] }),
        ),
      ),
  });
}

// ---- Reads ----------------------------------------------------------------

export const useCampaigns = (status?: CampaignStatus) =>
  useQuery(campaignsQuery(status));

export const useCampaignResults = (campaignId: string) =>
  useQuery(campaignResultsQuery(campaignId));

/** One results request per campaign id; the list summarises the finished ones. */
export function useCampaignResultsMany(campaignIds: readonly string[]) {
  return useQueries({
    queries: campaignIds.map((campaignId) => campaignResultsQuery(campaignId)),
  });
}

export const useSegments = () => useQuery(segmentsQuery());

export const useSegmentPreview = (definition?: SegmentDefinition) =>
  useQuery(segmentPreviewQuery(definition));

// ---- Writes ---------------------------------------------------------------

export function useCreateCampaign() {
  return useInvalidateOnSuccess(
    (body: Parameters<typeof api.createCampaign>[0]) =>
      api.createCampaign(body),
    [listCampaigns],
  );
}

export function useUpdateCampaign() {
  return useInvalidateOnSuccess(
    (variables: {
      campaignId: Campaign["id"];
      body: Parameters<typeof api.updateCampaign>[1];
    }) =>
      api.updateCampaign({ campaignId: variables.campaignId }, variables.body),
    [listCampaigns, getCampaignResults],
  );
}
