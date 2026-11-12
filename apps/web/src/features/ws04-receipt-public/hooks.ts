import { useQuery } from "@tanstack/react-query";
import { publicSiteQuery } from "../ws08-website/queries.ts";
import { publicReceiptQuery } from "./queries.ts";

// The receipt is personal (Cache-Control: private, no-store): read in the
// browser only, never during SSR.
export function usePublicReceipt(token: string) {
  return useQuery({
    ...publicReceiptQuery(token),
    enabled: typeof window !== "undefined",
  });
}

/** Brand name for the page header; optional, the receipt never waits for it. */
export function useReceiptBrand() {
  const query = useQuery({
    ...publicSiteQuery(),
    enabled: typeof window !== "undefined",
  });
  return query.data?.brand.name ?? null;
}
