// Whether PDFs may be offered. Components never call apiFetch directly.
import { useQuery } from "@tanstack/react-query";
import { storageCapabilitiesQuery } from "./queries";

/** Loading or failed reads as "no PDF": the safe side, photos only. */
export function useStorageCapabilities() {
  const query = useQuery(storageCapabilitiesQuery());
  return {
    documentsAccepted: query.data?.data.documentsAccepted === true,
  };
}
