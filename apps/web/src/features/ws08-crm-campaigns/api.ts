// Typed callers for the campaign writes and the audience preview
// (docs/frontend.md "Typed endpoints and mock mode"). Components never call
// these directly: they use the hooks in ./hooks.ts, which own cache keys and
// invalidation. Reads (campaign list, results, segments) go through
// `endpointQueryOptions` in ./queries.ts.
//
// Campaign endpoints come from the CRM contract (bead legend-zk25). The
// audience picker only reads and previews segments; segment CRUD belongs to
// the CRM segment screens (bead legend-i026), never to this feature.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createCampaign as createCampaignEndpoint,
  previewSegment,
  updateCampaign as updateCampaignEndpoint,
  type SegmentDefinition,
} from "@starter/shared/crm";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];

export const createCampaign = (body: Body<typeof createCampaignEndpoint>) =>
  callEndpoint(createCampaignEndpoint, { body }).then(
    (response) => response.data,
  );

export const updateCampaign = (
  params: Params<typeof updateCampaignEndpoint>,
  body: Body<typeof updateCampaignEndpoint>,
) =>
  callEndpoint(updateCampaignEndpoint, { params, body }).then(
    (response) => response.data,
  );

/** POST /api/segments/preview: the live audience size for a definition. */
export async function previewAudience(
  definition: SegmentDefinition,
  signal?: AbortSignal,
) {
  const response = await callEndpoint(
    previewSegment,
    { body: { definition } },
    { signal },
  );
  return response.data;
}
