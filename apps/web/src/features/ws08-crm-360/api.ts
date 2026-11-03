// One typed caller per CRM back-office endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Components never call these directly: they use
// the hooks in ./hooks.ts, which own cache keys and invalidation.
//
// The CRM contract (bead legend-i026) already ships these endpoints:
// listCustomers / getCustomer360 / listCustomerPoints, listSegments /
// createSegment / previewSegment and listFeedback / updateFeedback. The tier,
// menu and outlet catalogs are read-only lookups for the segment rule pickers;
// this feature never registers a mock for them.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  createSegment as createSegmentEndpoint,
  getCustomer360,
  listCustomerPoints,
  listCustomers,
  listFeedback,
  listSegments,
  previewSegment as previewSegmentEndpoint,
  updateFeedback as updateFeedbackEndpoint,
} from "@starter/shared/crm";
import { listItems } from "@starter/shared/menu";
import { orgEndpoints } from "@starter/shared/platform";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Customer 360 ---------------------------------------------------------

export const fetchCustomers = (
  query: Query<typeof listCustomers>,
  signal?: AbortSignal,
) => callEndpoint(listCustomers, { query }, { signal });

export const fetchCustomer360 = (
  customerProfileId: string,
  signal?: AbortSignal,
) =>
  callEndpoint(
    getCustomer360,
    { params: { customerProfileId } },
    { signal },
  ).then((response) => response.data);

export const fetchCustomerPoints = (
  customerProfileId: string,
  query: Query<typeof listCustomerPoints>,
  signal?: AbortSignal,
) =>
  callEndpoint(
    listCustomerPoints,
    { params: { customerProfileId }, query },
    { signal },
  );

// ---- Segments -------------------------------------------------------------

export const fetchSegments = (
  query: Query<typeof listSegments>,
  signal?: AbortSignal,
) => callEndpoint(listSegments, { query }, { signal });

export const createSegment = (body: Body<typeof createSegmentEndpoint>) =>
  callEndpoint(createSegmentEndpoint, { body }).then(
    (response) => response.data,
  );

export const fetchSegmentPreview = (
  body: Body<typeof previewSegmentEndpoint>,
  signal?: AbortSignal,
) =>
  callEndpoint(previewSegmentEndpoint, { body }, { signal }).then(
    (response) => response.data,
  );

// ---- Feedback queue -------------------------------------------------------

export const fetchFeedback = (
  query: Query<typeof listFeedback>,
  signal?: AbortSignal,
) => callEndpoint(listFeedback, { query }, { signal });

export const updateFeedback = (
  params: Params<typeof updateFeedbackEndpoint>,
  body: Body<typeof updateFeedbackEndpoint>,
) =>
  callEndpoint(updateFeedbackEndpoint, { params, body }).then(
    (response) => response.data,
  );

// ---- Read-only catalogs for the segment rule pickers ----------------------

export async function fetchMenuItems(signal?: AbortSignal) {
  const response = await callEndpoint(
    listItems,
    { query: { limit: 100 } },
    { signal },
  );
  return response.data;
}

export async function fetchOutlets(signal?: AbortSignal) {
  const response = await callEndpoint(
    orgEndpoints.listOutlets,
    { query: { limit: 50 } },
    { signal },
  );
  return response.data;
}
