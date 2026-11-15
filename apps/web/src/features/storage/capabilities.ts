// What the upload pipeline accepts (e.g. whether PDFs may be offered): typed
// caller, query and hook in one module, kept apart from the upload client so
// that client does not load the generic endpoint caller.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { getStorageCapabilities } from "@starter/shared/storage";
import { callEndpoint } from "@/lib/api/endpoint";

export const fetchStorageCapabilities = (signal?: AbortSignal) =>
  callEndpoint(getStorageCapabilities, {}, { signal });

/** The server's setup changes on a deploy, not during a session. */
export const storageCapabilitiesQuery = () =>
  queryOptions({
    queryKey: ["storage-capabilities"] as const,
    queryFn: ({ signal }) => fetchStorageCapabilities(signal),
    staleTime: 5 * 60 * 1000,
  });

/** Loading or failed reads as "no PDF": the safe side, photos only. */
export function useStorageCapabilities() {
  const query = useQuery(storageCapabilitiesQuery());
  return {
    documentsAccepted: query.data?.data.documentsAccepted === true,
  };
}
