// Typed endpoint contracts for the public brand website (PRD v1.7 §3 F21 /
// §3.24). Both routes are public: the tenant comes from the host name
// (D-CORE-3), never from a query parameter, so the same SSR code serves every
// brand domain without trusting client input.

import { dataResponseSchema } from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import { publicMenuPageSchema, publicSiteSchema } from "./schemas.ts";

/** Home page payload: brand, outlet, hours, location, featured menu, promos, SEO. */
export const getPublicSite = defineEndpoint({
  method: "GET",
  path: "/api/public/site",
  response: dataResponseSchema(publicSiteSchema),
});

/** Online menu page payload (sections, items, channel price, sold-out status). */
export const getPublicMenuPage = defineEndpoint({
  method: "GET",
  path: "/api/public/site/menu",
  response: dataResponseSchema(publicMenuPageSchema),
});
