import { useCallback, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { StorageVariant } from "@starter/shared/storage";
import { uploadStorageFile } from "./api";
import { storageCapabilitiesQuery, storageObjectUrlQuery } from "./queries";

function unexpiredSnapshot(expiresAt: string | undefined): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) > Date.now();
}

function subscribeToExpiry(
  expiresAt: string | undefined,
  onChange: () => void,
) {
  if (expiresAt === undefined || !unexpiredSnapshot(expiresAt)) return () => {};
  const timeout = window.setTimeout(
    onChange,
    Math.max(1, Date.parse(expiresAt) - Date.now() + 1),
  );
  return () => window.clearTimeout(timeout);
}

const serverExpiredSnapshot = () => false;

export function useUploadStorageFile() {
  return useMutation({ mutationFn: uploadStorageFile });
}

/** Use onError on the image to renew a URL rejected by the storage provider. */
export function useStorageObjectUrl(
  objectId: string | null | undefined,
  variant: StorageVariant = "original",
) {
  const query = useQuery({
    ...storageObjectUrlQuery(objectId ?? "", variant),
    // This endpoint is POST: cookies and the browser Origin are needed.
    enabled: Boolean(objectId) && typeof window !== "undefined",
  });
  const expiresAt = query.data?.expiresAt;
  const unexpired = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => subscribeToExpiry(expiresAt, onChange),
      [expiresAt],
    ),
    useCallback(() => unexpiredSnapshot(expiresAt), [expiresAt]),
    serverExpiredSnapshot,
  );
  const usable = !query.isError && unexpired;
  return {
    ...query,
    url: usable ? query.data?.url : undefined,
    onError: () => {
      if (objectId) void query.refetch();
    },
  };
}

/** Loading or failed reads as "no PDF": the safe side, photos only. */
export function useStorageCapabilities() {
  const query = useQuery(storageCapabilitiesQuery());
  return {
    documentsAccepted: query.data?.data.documentsAccepted === true,
  };
}
