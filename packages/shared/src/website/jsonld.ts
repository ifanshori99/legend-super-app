// JSON-LD for the public website (PRD v1.7 §3 F21 "SEO Lokal": SSR, meta tag,
// JSON-LD `Restaurant` and `Menu`, opening hours, location, sitemap and the
// Google Business Profile link).
//
// The structures below are schema.org, not our database shape: they are built
// from the public site/menu DTOs by pure functions so the SSR route, the
// sitemap and the tests produce exactly the same markup. Prices in JSON-LD are
// whole-rupiah strings ("32000"), the form schema.org `Offer.price` expects.
//
// `serializeJsonLd` is mandatory for the SSR `<script type="application/ld+json">`
// block: JSON.stringify alone lets a menu item named `</script>` close the tag,
// so `<`, U+2028 and U+2029 are escaped.

import { z, isoDateTimeSchema } from "../core/index.ts";
import {
  PUBLIC_SITE_ROUTES,
  publicMenuItemSchema,
  publicSiteSchema,
} from "./schemas.ts";
import type { PublicMenuPage, PublicSite, SitemapEntry } from "./schemas.ts";
import { sitemapEntrySchema } from "./schemas.ts";

const jsonLdContextSchema = z.literal("https://schema.org");
const schemaDaySchema = z.enum([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);
const SCHEMA_DAYS = schemaDaySchema.options;

const postalAddressJsonLdSchema = z.strictObject({
  "@type": z.literal("PostalAddress"),
  streetAddress: z.string().min(1).max(200),
  addressLocality: z.string().min(1).max(100),
  addressRegion: z.string().min(1).max(100),
  postalCode: z.string().regex(/^[0-9]{5}$/),
  addressCountry: z.literal("ID"),
});

const geoJsonLdSchema = z.strictObject({
  "@type": z.literal("GeoCoordinates"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

const openingHoursJsonLdSchema = z.strictObject({
  "@type": z.literal("OpeningHoursSpecification"),
  dayOfWeek: z.array(schemaDaySchema).min(1),
  opens: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
  closes: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
});

/** schema.org Restaurant for the outlet home page (PRD F21 "SEO Lokal"). */
export const restaurantJsonLdSchema = z.strictObject({
  "@context": jsonLdContextSchema,
  "@type": z.literal("Restaurant"),
  name: z.string().min(1).max(150),
  description: z.string().min(1).max(600),
  url: z.url(),
  image: z.array(z.url()).min(1),
  telephone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  servesCuisine: z.array(z.string().min(1).max(40)).min(1),
  priceRange: z.string().min(1).max(40),
  address: postalAddressJsonLdSchema,
  geo: geoJsonLdSchema,
  openingHoursSpecification: z.array(openingHoursJsonLdSchema).min(1),
  acceptsReservations: z.boolean(),
  hasMenu: z.url(),
  sameAs: z.array(z.url()),
});
export type RestaurantJsonLd = z.infer<typeof restaurantJsonLdSchema>;

const menuItemJsonLdSchema = z.strictObject({
  "@type": z.literal("MenuItem"),
  name: z.string().min(1).max(150),
  description: z.string().max(500),
  offers: z.strictObject({
    "@type": z.literal("Offer"),
    /** Whole rupiah as a string, the form schema.org `Offer.price` expects. */
    price: z.string().regex(/^[0-9]+$/),
    priceCurrency: z.literal("IDR"),
    availability: z.enum([
      "https://schema.org/InStock",
      "https://schema.org/OutOfStock",
    ]),
  }),
});

/** schema.org Menu for the online menu page (PRD F21 "Menu Online"). */
export const menuJsonLdSchema = z.strictObject({
  "@context": jsonLdContextSchema,
  "@type": z.literal("Menu"),
  name: z.string().min(1).max(150),
  hasMenuSection: z
    .array(
      z.strictObject({
        "@type": z.literal("MenuSection"),
        name: z.string().min(1).max(150),
        hasMenuItem: z.array(menuItemJsonLdSchema),
      }),
    )
    .min(1),
});
export type MenuJsonLd = z.infer<typeof menuJsonLdSchema>;

/**
 * Restaurant JSON-LD from the site payload. `menuUrl` is the online menu page
 * URL (`seo.canonicalUrl` of the menu page is not on the home payload, so the
 * caller passes the absolute URL it already resolved).
 */
export function buildRestaurantJsonLd(
  site: PublicSite,
  menuUrl: string,
): RestaurantJsonLd {
  const { outlet, brand, contact, seo } = publicSiteSchema.parse(site);
  return restaurantJsonLdSchema.parse({
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: outlet.name,
    description: brand.description,
    url: seo.canonicalUrl,
    image: site.heroImages.map((image) => image.url),
    telephone: `+${contact.whatsapp}`,
    servesCuisine: ["Kopi", "Masakan Nusantara", "Pastry"],
    priceRange: "Rp20.000 - Rp150.000",
    address: {
      "@type": "PostalAddress",
      streetAddress: outlet.address.streetLine,
      addressLocality: outlet.address.city,
      addressRegion: outlet.address.province,
      postalCode: outlet.address.postalCode,
      addressCountry: outlet.address.country,
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: outlet.geo.latitude,
      longitude: outlet.geo.longitude,
    },
    openingHoursSpecification: outlet.openingHours.map((hours) => ({
      "@type": "OpeningHoursSpecification" as const,
      dayOfWeek: hours.daysOfWeek.map((day) => SCHEMA_DAYS[day]),
      opens: hours.opens,
      closes: hours.closes,
    })),
    acceptsReservations: site.acceptsReservations,
    hasMenu: z.url().parse(menuUrl),
    sameAs: [contact.instagramUrl, contact.googleBusinessProfileUrl].filter(
      (url): url is string => url !== null,
    ),
  });
}

/** Menu JSON-LD from the menu page payload, section by section. */
export function buildMenuJsonLd(
  page: PublicMenuPage,
  menuName: string,
): MenuJsonLd {
  return menuJsonLdSchema.parse({
    "@context": "https://schema.org",
    "@type": "Menu",
    name: menuName,
    hasMenuSection: page.sections.map((section) => ({
      "@type": "MenuSection" as const,
      name: section.name,
      hasMenuItem: section.items.map((item) => {
        const parsed = publicMenuItemSchema.parse(item);
        return {
          "@type": "MenuItem" as const,
          name: parsed.name,
          description: parsed.description,
          offers: {
            "@type": "Offer" as const,
            price: String(parsed.priceIdr),
            priceCurrency: "IDR" as const,
            availability: parsed.isAvailable
              ? ("https://schema.org/InStock" as const)
              : ("https://schema.org/OutOfStock" as const),
          },
        };
      }),
    })),
  });
}

/**
 * XSS-safe JSON-LD text for an SSR `<script type="application/ld+json">` block.
 * `<` becomes `\u003c` so a product name containing `</script>` cannot close
 * the tag; U+2028/U+2029 (legal in JSON, illegal in JS source) are escaped too.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Sitemap entries for the brand site (PRD F21 "sitemap"): home, online menu,
 * reservation and member entry, absolute from the canonical URL.
 */
export function sitemapEntriesFor(site: PublicSite): SitemapEntry[] {
  const canonical = z.url().parse(site.seo.canonicalUrl);
  const origin = new URL(canonical).origin;
  const lastModified = isoDateTimeSchema.parse(site.updatedAt);
  return [
    sitemapEntrySchema.parse({
      loc: `${origin}${PUBLIC_SITE_ROUTES.home}`,
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    }),
    sitemapEntrySchema.parse({
      loc: `${origin}${PUBLIC_SITE_ROUTES.menu}`,
      lastModified,
      changeFrequency: "weekly",
      priority: 0.8,
    }),
    sitemapEntrySchema.parse({
      loc: `${origin}${PUBLIC_SITE_ROUTES.reservation}`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.9,
    }),
    // A member page is a login entry, not a landing page.
    sitemapEntrySchema.parse({
      loc: `${origin}${PUBLIC_SITE_ROUTES.member}`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.3,
    }),
  ];
}
