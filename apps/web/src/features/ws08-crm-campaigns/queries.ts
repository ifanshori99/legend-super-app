// Query keys and options for the campaign screens. Campaign queries are keyed
// by the endpoint id through `endpointQueryOptions`, so
// `invalidateQueries({ queryKey: [endpoint.id] })` refreshes every screen that
// reads the same rows.
import { queryOptions } from "@tanstack/react-query";
import {
  getCampaignResults,
  listCampaigns,
  listSegments,
  previewSegment,
  type CampaignStatus,
  type SegmentDefinition,
} from "@starter/shared/crm";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { previewAudience } from "./api";

export const campaignsQuery = (status?: CampaignStatus) =>
  endpointQueryOptions(listCampaigns, {
    query: status === undefined ? { limit: 100 } : { limit: 100, status },
  });

export const campaignResultsQuery = (campaignId: string) =>
  endpointQueryOptions(getCampaignResults, { params: { campaignId } });

/**
 * Segments for the audience picker. Read-only here: the CRM segment bead
 * (legend-i026) owns the list, create and preview endpoints.
 */
export const segmentsQuery = () =>
  endpointQueryOptions(listSegments, { query: { limit: 100 } });

/**
 * Live audience size for one segment definition (POST /api/segments/preview).
 * Disabled until a segment is chosen, so opening the form sends nothing.
 */
export function segmentPreviewQuery(definition?: SegmentDefinition) {
  return queryOptions({
    queryKey: [previewSegment.id, definition ?? null],
    queryFn: ({ signal }) => {
      if (!definition)
        throw new Error("A segment definition is required for the preview.");
      return previewAudience(definition, signal);
    },
    enabled: definition !== undefined,
  });
}
