// Typed caller for the storage capabilities. Components use ./hooks.ts.
import { getStorageCapabilities } from "@starter/shared/storage";
import { callEndpoint } from "@/lib/api/endpoint";

export const fetchStorageCapabilities = (signal?: AbortSignal) =>
  callEndpoint(getStorageCapabilities, {}, { signal });
