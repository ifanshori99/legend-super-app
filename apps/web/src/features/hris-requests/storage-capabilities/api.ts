import { z } from "@starter/shared/core";
import { API_URL } from "@/lib/env";
import { ApiError, NETWORK_ERROR_MESSAGE } from "@/lib/api/errors";

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
