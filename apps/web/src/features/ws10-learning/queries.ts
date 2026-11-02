// Query keys and options for the WS-10 learning back office. Keyed by the
// endpoint id through `endpointQueryOptions`, so invalidating `[endpoint.id]`
// refreshes every screen that reads the same rows.
import { queryOptions } from "@tanstack/react-query";
import {
  getMyHrisProfile,
  listAnnouncements,
  listEmployees,
  listKpiReviews,
  listPositions,
  listSopDocuments,
  listTrainings,
} from "@starter/shared/hris";
import { endpointQueryOptions } from "@/lib/api/endpoint";
import { fetchMyProfile } from "./api";
import { LIST_LIMIT } from "./lib";

export const kpiReviewsQuery = () =>
  endpointQueryOptions(listKpiReviews, { query: { limit: LIST_LIMIT } });

export const sopDocumentsQuery = () =>
  endpointQueryOptions(listSopDocuments, { query: { limit: LIST_LIMIT } });

export const trainingsQuery = () =>
  endpointQueryOptions(listTrainings, { query: { limit: LIST_LIMIT } });

export const announcementsQuery = () =>
  endpointQueryOptions(listAnnouncements, { query: { limit: LIST_LIMIT } });

/** Employee names for the KPI list and the announcement receipts. */
export const employeesQuery = () =>
  endpointQueryOptions(listEmployees, { query: { limit: LIST_LIMIT } });

/** Position names for KPI rows and the SOP/training scope. */
export const positionsQuery = () =>
  endpointQueryOptions(listPositions, { query: { limit: LIST_LIMIT } });

/**
 * The signed-in employee. The PWA contract returns `{ employee, outlet }`;
 * queries read it through `fetchMyProfile` so keys stay stable.
 */
export const myProfileQuery = () =>
  queryOptions({
    queryKey: [getMyHrisProfile.id, "me"],
    queryFn: ({ signal }) => fetchMyProfile(signal),
  });
