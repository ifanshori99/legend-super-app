// Data hooks for the public website. The route loader fills the cache during
// SSR; components read it with suspense so the HTML already contains the page.
import { useSuspenseQuery } from "@tanstack/react-query";
import { publicMenuPageQuery, publicSiteQuery } from "./queries.ts";

export function usePublicSite() {
  return useSuspenseQuery(publicSiteQuery()).data;
}

export function usePublicMenuPage() {
  return useSuspenseQuery(publicMenuPageQuery()).data;
}
