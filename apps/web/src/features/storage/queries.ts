// Query key and options for what the upload pipeline accepts.
import { queryOptions } from "@tanstack/react-query";
import { fetchStorageCapabilities } from "./api";

/** The server's setup changes on a deploy, not during a session. */
export const storageCapabilitiesQuery = () =>
  queryOptions({
    queryKey: ["storage-capabilities"] as const,
    queryFn: ({ signal }) => fetchStorageCapabilities(signal),
    staleTime: 5 * 60 * 1000,
  });
