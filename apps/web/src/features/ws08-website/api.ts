// Public brand website endpoints (PRD v1.7 §3.24 "Website Publik per Brand").
// Both routes are public and read-only; the tenant comes from the host name on
// the API side (D-CORE-3), never from this app. The typed caller validates the
// response shape, and mock mode serves the same functions from the website
// fixtures (features/ws08-website/mock.ts).
import { getPublicMenuPage, getPublicSite } from "@starter/shared/website";
import { callEndpoint } from "@/lib/api/endpoint";

/** Home page payload: brand, outlet, hours, featured menu, promos, SEO. */
export function fetchPublicSite(signal?: AbortSignal) {
  return callEndpoint(getPublicSite, undefined, { signal }).then(
    (response) => response.data,
  );
}

/** Online menu payload: sections, items, channel prices, sold-out status. */
export function fetchPublicMenuPage(signal?: AbortSignal) {
  return callEndpoint(getPublicMenuPage, undefined, { signal }).then(
    (response) => response.data,
  );
}
