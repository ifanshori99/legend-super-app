// One typed caller per WS-10 learning endpoint (docs/frontend.md "Typed
// endpoints and mock mode"). Components never call these directly: the hooks in
// ./hooks.ts own cache keys and invalidation.
//
// The contracts already exist (bead legend-i7fc): listKpiReviews,
// listSopDocuments, acknowledgeSopDocument, listTrainings, completeTraining,
// listAnnouncements (served by lib/mock/handlers/hris-directory.ts) and
// markAnnouncementRead. Quiz grading stays on the server side of
// `completeTraining`: the answer key never reaches this bundle.
import type { AnyEndpoint, EndpointInput } from "@starter/shared/api";
import {
  acknowledgeSopDocument,
  completeTraining,
  getMyHrisProfile,
  listAnnouncements,
  listEmployees,
  listKpiReviews,
  listPositions,
  listSopDocuments,
  listTrainings,
  markAnnouncementRead as markAnnouncementReadEndpoint,
} from "@starter/shared/hris";
import { callEndpoint } from "@/lib/api/endpoint";

type Body<E extends AnyEndpoint> = EndpointInput<E>["body"];
type Params<E extends AnyEndpoint> = EndpointInput<E>["params"];
type Query<E extends AnyEndpoint> = EndpointInput<E>["query"];

// ---- Reads ---------------------------------------------------------------

export async function fetchKpiReviews(
  query: Query<typeof listKpiReviews>,
  signal?: AbortSignal,
) {
  return callEndpoint(listKpiReviews, { query }, { signal });
}

export async function fetchSopDocuments(
  query: Query<typeof listSopDocuments>,
  signal?: AbortSignal,
) {
  return callEndpoint(listSopDocuments, { query }, { signal });
}

export async function fetchTrainings(
  query: Query<typeof listTrainings>,
  signal?: AbortSignal,
) {
  return callEndpoint(listTrainings, { query }, { signal });
}

export async function fetchAnnouncements(
  query: Query<typeof listAnnouncements>,
  signal?: AbortSignal,
) {
  return callEndpoint(listAnnouncements, { query }, { signal });
}

export async function fetchEmployees(
  query: Query<typeof listEmployees>,
  signal?: AbortSignal,
) {
  return callEndpoint(listEmployees, { query }, { signal });
}

export async function fetchPositions(
  query: Query<typeof listPositions>,
  signal?: AbortSignal,
) {
  return callEndpoint(listPositions, { query }, { signal });
}

export async function fetchMyProfile(signal?: AbortSignal) {
  const response = await callEndpoint(getMyHrisProfile, {}, { signal });
  return response.data;
}

// ---- Writes --------------------------------------------------------------

export const acknowledgeSop = (
  params: Params<typeof acknowledgeSopDocument>,
  body: Body<typeof acknowledgeSopDocument>,
) =>
  callEndpoint(acknowledgeSopDocument, { params, body }).then(
    (response) => response.data,
  );

export const submitTrainingAnswers = (
  params: Params<typeof completeTraining>,
  body: Body<typeof completeTraining>,
) =>
  callEndpoint(completeTraining, { params, body }).then(
    (response) => response.data,
  );

export const markAnnouncementRead = (
  params: Params<typeof markAnnouncementReadEndpoint>,
  body: Body<typeof markAnnouncementReadEndpoint>,
) =>
  callEndpoint(markAnnouncementReadEndpoint, { params, body }).then(
    (response) => response.data,
  );
