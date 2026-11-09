// Public brand website contract (PRD v1.7 §3 F21 / §3.24 "Website Publik per
// Brand"): the content the SSR website renders for Cafe Legend — brand profile,
// outlet location and opening hours, featured menu, promotions, the online menu
// page and its SEO metadata.
//
// The website is read-only public data: no tenant id, no member data and no
// prices computed here. Menu prices come from the outlet price list and, per
// the owner decision of 1 Nov 2026, exclude tax and service charge; every page
// that shows a price therefore carries `pricesExcludeTaxAndService: true` and
// the FE renders the i18n disclosure.
//
// JSON-LD (`Restaurant` + `Menu`) lives in `jsonld.ts`: the structures are
// schema.org, not our database shape, so they are built from these DTOs by
// deterministic functions the website can unit test.

import {
  z,
  brandIdSchema,
  outletIdSchema,
  uuidSchema,
  idrSchema,
  businessDateSchema,
  isoDateTimeSchema,
  timeOfDaySchema,
  timeZoneSchema,
} from "../core/index.ts";

const name = z.string().min(1).max(150);
const nonnegativeIdr = idrSchema.refine((value) => value >= 0);
const httpsUrlSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Expected an https URL",
});
const phoneDigitsSchema = z
  .string()
  .regex(
    /^[1-9][0-9]{7,14}$/,
    "Phone numbers are digits in international form, e.g. 6281234567890",
  );

// ---- Shared building blocks ----------------------------------------------

export const publicImageSchema = z.strictObject({
  url: httpsUrlSchema,
  /** Required: an image without alternative text fails accessibility review. */
  alt: z.string().min(1).max(200),
});
export type PublicImage = z.infer<typeof publicImageSchema>;

/** 0 = Sunday, matching `Date#getDay` and the rest of the contracts. */
export const publicOpeningHoursSchema = z
  .strictObject({
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    opens: timeOfDaySchema,
    closes: timeOfDaySchema,
  })
  .refine((hours) => hours.closes !== hours.opens, {
    path: ["closes"],
    message: "Opening and closing time differ",
  });
export type PublicOpeningHours = z.infer<typeof publicOpeningHoursSchema>;

export const publicAddressSchema = z.strictObject({
  streetLine: z.string().min(1).max(200),
  district: z.string().max(100).nullable(),
  city: z.string().min(1).max(100),
  province: z.string().min(1).max(100),
  postalCode: z.string().regex(/^[0-9]{5}$/),
  country: z.literal("ID"),
});
export type PublicAddress = z.infer<typeof publicAddressSchema>;

export const publicGeoSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type PublicGeo = z.infer<typeof publicGeoSchema>;

export const publicContactSchema = z.strictObject({
  whatsapp: phoneDigitsSchema,
  email: z.email().nullable(),
  instagramUrl: httpsUrlSchema.nullable(),
  googleBusinessProfileUrl: httpsUrlSchema.nullable(),
});
export type PublicContact = z.infer<typeof publicContactSchema>;

export const publicPromotionSummarySchema = z.strictObject({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(300),
  validUntil: businessDateSchema.nullable(),
});
export type PublicPromotionSummary = z.infer<
  typeof publicPromotionSummarySchema
>;

/** The outlet a guest can visit, as the website shows it. */
export const publicOutletSchema = z.strictObject({
  id: outletIdSchema,
  code: z.string().regex(/^[A-Z0-9-]{1,20}$/),
  name,
  timeZone: timeZoneSchema,
  address: publicAddressSchema,
  geo: publicGeoSchema,
  /** Google Maps link the guest opens on their phone. */
  mapUrl: httpsUrlSchema,
  openingHours: z.array(publicOpeningHoursSchema).min(1),
});
export type PublicOutlet = z.infer<typeof publicOutletSchema>;

// ---- SEO metadata ---------------------------------------------------------

export const seoMetaSchema = z.strictObject({
  /** At most 60 characters, the search-snippet title budget. */
  title: z.string().min(1).max(60),
  /** At most 160 characters, the search-snippet description budget. */
  description: z.string().min(1).max(160),
  canonicalUrl: httpsUrlSchema,
  ogImageUrl: httpsUrlSchema.nullable(),
  robots: z.enum(["index,follow", "noindex,nofollow"]),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
});
export type SeoMeta = z.infer<typeof seoMetaSchema>;

export const sitemapEntrySchema = z.strictObject({
  loc: httpsUrlSchema,
  lastModified: isoDateTimeSchema,
  changeFrequency: z.enum(["daily", "weekly", "monthly"]),
  /** 0.0–1.0, the sitemap priority signal. */
  priority: z.number().min(0).max(1),
});
export type SitemapEntry = z.infer<typeof sitemapEntrySchema>;

// ---- Menu page ------------------------------------------------------------

export const publicMenuItemSchema = z.strictObject({
  id: uuidSchema,
  name,
  description: z.string().max(500),
  /** Price list price; excludes tax and service charge (owner decision). */
  priceIdr: nonnegativeIdr,
  imageUrl: httpsUrlSchema.nullable(),
  labels: z.array(z.string().min(1).max(40)).max(5),
  allergens: z.array(z.string().min(1).max(40)).max(10),
  isAvailable: z.boolean(),
});
export type PublicMenuItem = z.infer<typeof publicMenuItemSchema>;

export const publicMenuSectionSchema = z.strictObject({
  id: uuidSchema,
  name,
  description: z.string().max(300).nullable(),
  sortOrder: z.number().int(),
  items: z.array(publicMenuItemSchema),
});
export type PublicMenuSection = z.infer<typeof publicMenuSectionSchema>;

export const publicMenuPageSchema = z.strictObject({
  sections: z.array(publicMenuSectionSchema).min(1),
  /** PRD F21 online menu; owner rule: prices exclude tax and service charge. */
  pricesExcludeTaxAndService: z.literal(true),
  updatedAt: isoDateTimeSchema,
});
export type PublicMenuPage = z.infer<typeof publicMenuPageSchema>;

// ---- Site (home) ----------------------------------------------------------

export const publicBrandSchema = z.strictObject({
  id: brandIdSchema,
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name,
  tagline: z.string().min(1).max(120),
  description: z.string().min(1).max(600),
});
export type PublicBrand = z.infer<typeof publicBrandSchema>;

export const publicHighlightSchema = z.strictObject({
  title: z.string().min(1).max(80),
  description: z.string().min(1).max(300),
});
export type PublicHighlight = z.infer<typeof publicHighlightSchema>;

/** Featured menu card on the home page (subset of the menu page item). */
export const publicFeaturedItemSchema = publicMenuItemSchema.pick({
  id: true,
  name: true,
  description: true,
  priceIdr: true,
  imageUrl: true,
});
export type PublicFeaturedItem = z.infer<typeof publicFeaturedItemSchema>;

export const publicSiteSchema = z.strictObject({
  brand: publicBrandSchema,
  outlet: publicOutletSchema,
  heroImages: z.array(publicImageSchema).min(1),
  gallery: z.array(publicImageSchema),
  highlights: z.array(publicHighlightSchema),
  featuredMenuItems: z.array(publicFeaturedItemSchema),
  promotions: z.array(publicPromotionSummarySchema),
  contact: publicContactSchema,
  seo: seoMetaSchema,
  /** PRD F21 "Reservasi & Member": the site links to both entry points. */
  acceptsReservations: z.boolean(),
  memberLoginUrl: httpsUrlSchema,
  pricesExcludeTaxAndService: z.literal(true),
  updatedAt: isoDateTimeSchema,
});
export type PublicSite = z.infer<typeof publicSiteSchema>;

// ---- Staff-edited site content ---------------------------------------------

/**
 * What staff write for a brand's public site (`brand_websites.content`): the
 * parts of `publicSiteSchema` that no other table holds. The brand name and
 * slug, the outlet code, name and hours, the featured menu, the promotions and
 * the reservation switch are read from their own tables at request time.
 */
export const brandWebsiteContentSchema = z.strictObject({
  tagline: publicBrandSchema.shape.tagline,
  description: publicBrandSchema.shape.description,
  heroImages: z.array(publicImageSchema).min(1).max(10),
  gallery: z.array(publicImageSchema).max(30),
  highlights: z.array(publicHighlightSchema).max(8),
  address: publicAddressSchema,
  /** Null until staff pick the pin; the site cannot publish without it. */
  geo: publicGeoSchema.nullable(),
  contact: publicContactSchema,
  seo: seoMetaSchema,
  /** Maps link the guest opens; null falls back to a pin on `geo`. */
  googleBusinessUrl: httpsUrlSchema.nullable(),
});
export type BrandWebsiteContent = z.infer<typeof brandWebsiteContentSchema>;

export const brandWebsiteParamsSchema = z.strictObject({
  brandId: brandIdSchema,
});

/** `GET /api/website/brands/:brandId/content` answer. */
export const brandWebsiteSchema = z.strictObject({
  brandId: brandIdSchema,
  outletId: outletIdSchema,
  content: brandWebsiteContentSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type BrandWebsite = z.infer<typeof brandWebsiteSchema>;

/** `PUT /api/website/brands/:brandId/content` body. */
export const saveBrandWebsiteInputSchema = z.strictObject({
  /** Featured outlet; omitted keeps the current one (first outlet on create). */
  outletId: outletIdSchema.optional(),
  content: brandWebsiteContentSchema,
  /** true publishes (or keeps published); false unpublishes the site. */
  publish: z.boolean(),
});
export type SaveBrandWebsiteInput = z.infer<typeof saveBrandWebsiteInputSchema>;

/** The website's own routes, used for navigation and the sitemap. */
export const publicSiteRoutesSchema = z.strictObject({
  home: z.literal("/"),
  menu: z.literal("/menu"),
  reservation: z.literal("/reservation"),
  member: z.literal("/member"),
});
export type PublicSiteRoutes = z.infer<typeof publicSiteRoutesSchema>;
export const PUBLIC_SITE_ROUTES: PublicSiteRoutes =
  publicSiteRoutesSchema.parse({
    home: "/",
    menu: "/menu",
    reservation: "/reservation",
    member: "/member",
  });
