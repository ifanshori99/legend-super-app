// What the upload pipeline accepts (e.g. whether PDFs may be offered): fetch,
// query and hook in one module. It reads the endpoint with a plain fetch and a
// strict parse (not the generic endpoint caller, which only validates in dev),
// so a malformed answer can never turn PDF on.
import { queryOptions, useQuery } from "@tanstack/react-query";
import { z } from "@starter/shared/core";
import { API_URL } from "@/lib/env";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";
import { useHydrated } from "../ws10-attendance-qr/use-hydrated.ts";

// Compatible with the storage-scanner-pdf capability endpoint. Until that
// endpoint is deployed, a failed read keeps PDF uploads unavailable.
const storageCapabilitiesResponse = z.strictObject({
  data: z.strictObject({ documentsAccepted: z.boolean() }),
});

/** Browser-only: callers wait for hydration, as uploads do. */
export async function fetchStorageCapabilities(signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(new URL("/api/storage/capabilities", API_URL), {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, "NETWORK_ERROR", NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      "SCANNER_UNAVAILABLE",
      "PDF uploads are unavailable.",
    );
  return storageCapabilitiesResponse.parse(await response.json());
}

/** The server's setup changes on a deploy, not during a session. */
export const storageCapabilitiesQuery = () =>
  queryOptions({
    queryKey: ["storage-capabilities"] as const,
    queryFn: ({ signal }) => fetchStorageCapabilities(signal),
    staleTime: 5 * 60 * 1000,
  });

/**
 * Loading, failed or malformed reads count as "no PDF": the safe side, photos
 * only. Waits for hydration so the read is browser-only, as uploads are.
 */
export function useStorageCapabilities() {
  const hydrated = useHydrated();
  const query = useQuery({ ...storageCapabilitiesQuery(), enabled: hydrated });
  return {
    documentsAccepted:
      query.isSuccess && query.data?.data?.documentsAccepted === true,
  };
}
