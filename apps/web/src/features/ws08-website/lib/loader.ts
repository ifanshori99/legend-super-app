import { notFound, rootRouteId } from "@tanstack/react-router";
import { ApiError } from "@/lib/api/errors";

/** Missing public content belongs in the site's 404 boundary, not its error UI. */
export async function loadWebsiteData<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404)
      throw notFound({ routeId: rootRouteId });
    throw error;
  }
}
