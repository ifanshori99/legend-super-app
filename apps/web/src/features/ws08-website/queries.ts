// Query keys and options for the public website. The endpoint caller returns
// the `{ data }` envelope; the api functions unwrap it, so components and the
// route head see the site/menu payload itself. Keys are hierarchical so a
// future tenant/brand switch can invalidate the whole site at once.
import { queryOptions } from "@tanstack/react-query";
import { fetchPublicMenuPage, fetchPublicSite } from "./api.ts";

export const websiteKeys = {
  all: ["website"] as const,
  site: () => [...websiteKeys.all, "site"] as const,
  menu: () => [...websiteKeys.all, "menu"] as const,
};

export function publicSiteQuery() {
  return queryOptions({
    queryKey: websiteKeys.site(),
    queryFn: ({ signal }) => fetchPublicSite(signal),
  });
}

export function publicMenuPageQuery() {
  return queryOptions({
    queryKey: websiteKeys.menu(),
    queryFn: ({ signal }) => fetchPublicMenuPage(signal),
  });
}
