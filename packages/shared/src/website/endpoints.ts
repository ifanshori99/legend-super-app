// Typed endpoint contracts for the public brand website (PRD v1.7 §3 F21 /
// §3.24). Both routes are public: the tenant comes from the host name
// (D-CORE-3), never from a query parameter, so the same SSR code serves every
// brand domain without trusting client input.

import { dataResponseSchema } from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  brandWebsiteParamsSchema,
  brandWebsiteSchema,
  publicMenuPageSchema,
  publicSiteSchema,
  saveBrandWebsiteInputSchema,
} from "./schemas.ts";

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

/**
 * Staff read of the brand's site content (`org.theme.manage`, tenant-wide).
 * 404 `BRAND_WEBSITE_NOT_FOUND` until a first save.
 */
export const getBrandWebsiteContent = defineEndpoint({
  method: "GET",
  path: "/api/website/brands/:brandId/content",
  params: brandWebsiteParamsSchema,
  response: dataResponseSchema(brandWebsiteSchema),
});

/** Staff save; `publish` controls `published_at` (same permission, audited). */
export const saveBrandWebsiteContent = defineEndpoint({
  method: "PUT",
  path: "/api/website/brands/:brandId/content",
  params: brandWebsiteParamsSchema,
  body: saveBrandWebsiteInputSchema,
  response: dataResponseSchema(brandWebsiteSchema),
});
