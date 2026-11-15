import { queryOptions } from "@tanstack/react-query";
import type { StorageVariant } from "@starter/shared/storage";
import { ApiError } from "@/lib/api/errors";
import { fetchStorageObjectUrl } from "./api";

export const STORAGE_URL_REFRESH_MARGIN_MS = 30_000;

export const storageKeys = {
  all: ["storage"] as const,
  objectUrl: (objectId: string, variant: StorageVariant = "original") =>
    [...storageKeys.all, objectId, variant] as const,
};

export function storageObjectUrlQuery(
  objectId: string,
  variant: StorageVariant = "original",
) {
  return queryOptions({
    queryKey: storageKeys.objectUrl(objectId, variant),
    queryFn: ({ signal }) => fetchStorageObjectUrl(objectId, variant, signal),
    enabled: objectId.length > 0,
    // TanStack measures staleTime from dataUpdatedAt, not the current render.
    staleTime: (query) => {
      const data = query.state.data;
      return data
        ? Math.max(
            0,
            Date.parse(data.expiresAt) -
              query.state.dataUpdatedAt -
              STORAGE_URL_REFRESH_MARGIN_MS,
          )
        : 0;
    },
    // staleTime alone does not refresh a mounted image. Schedule its renewal.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      if (query.state.status === "error") {
        const error = query.state.error;
        // A temporary provider/network outage must recover in a mounted image;
        // revoked access must wait for an explicit new attempt instead.
        return error instanceof ApiError &&
          (error.status === 0 ||
            error.status === 408 ||
            error.status === 429 ||
            error.status >= 500)
          ? 30_000
          : false;
      }
      return Math.max(
        1000,
        Date.parse(data.expiresAt) - Date.now() - STORAGE_URL_REFRESH_MARGIN_MS,
      );
    },
    refetchIntervalInBackground: true,
    retry: false,
  });
}
