import { queryOptions } from "@tanstack/react-query";
import { fetchStorageCapabilities } from "./api.ts";

export const storageCapabilitiesQuery = () =>
  queryOptions({
    queryKey: ["storage-capabilities"] as const,
    queryFn: ({ signal }) => fetchStorageCapabilities(signal),
    staleTime: 5 * 60 * 1000,
  });
