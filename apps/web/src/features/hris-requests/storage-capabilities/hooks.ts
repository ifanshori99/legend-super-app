import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "../../ws10-attendance-qr/use-hydrated.ts";
import { storageCapabilitiesQuery } from "./queries.ts";

/** Loading or failed reads offer photos only. */
export function useStorageCapabilities() {
  const hydrated = useHydrated();
  const query = useQuery({
    ...storageCapabilitiesQuery(),
    enabled: hydrated,
  });
  return {
    documentsAccepted:
      query.isSuccess && query.data?.data?.documentsAccepted === true,
  };
}
