// SEO for the public brand website (PRD v1.7 §3.24 "SEO Lokal"): meta tags,
// canonical links, JSON-LD `Restaurant` + `Menu`, the sitemap XML and
// robots.txt. Pure builders so the route head, the sitemap route and the unit
// tests produce exactly the same markup; the schema.org structures themselves
// come from @starter/shared/website (contract bead legend-m7ak).
//
// No router import: tests load this file with plain Node type stripping.
import {
  buildMenuJsonLd,
  buildRestaurantJsonLd,
  serializeJsonLd,
  sitemapEntriesFor,
} from "@starter/shared/website";
import type {
  PublicMenuPage,
  PublicSite,
  SitemapEntry,
} from "@starter/shared/website";

type HeadMeta = {
  title?: string;
  name?: string;
  property?: string;
  content?: string;
};
type HeadLink = { rel: string; href: string };
type HeadScript = { type: string; children: string };

/** The `<head>` shape a TanStack Router route returns. */
export type SiteHead = {
  meta: HeadMeta[];
  links: HeadLink[];
  scripts: HeadScript[];
};

/** Resolves a site path against the brand's canonical URL. */
export function absoluteUrl(canonicalUrl: string, path: string): string {
  return new URL(path, canonicalUrl).toString();
}

function jsonLdScript(value: unknown): HeadScript {
  return { type: "application/ld+json", children: serializeJsonLd(value) };
}

function socialMeta(input: {
  title: string;
  description: string;
  url: string;
  siteName: string;
  ogImageUrl: string | null;
}): HeadMeta[] {
  return [
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: input.siteName },
    { property: "og:title", content: input.title },
    { property: "og:description", content: input.description },
    { property: "og:url", content: input.url },
    ...(input.ogImageUrl
      ? [{ property: "og:image", content: input.ogImageUrl }]
      : []),
    { name: "twitter:card", content: "summary_large_image" },
  ];
}

/**
 * Home page head: the brand's own SEO metadata from the site payload plus the
 * Restaurant JSON-LD (address, geo, opening hours, menu link, reservations).
 */
export function homeHead(site: PublicSite, menuUrl: string): SiteHead {
  const canonical = site.seo.canonicalUrl;
  return {
    meta: [
      { title: site.seo.title },
      { name: "description", content: site.seo.description },
      { name: "robots", content: site.seo.robots },
      ...socialMeta({
        title: site.seo.title,
        description: site.seo.description,
        url: canonical,
        siteName: site.brand.name,
        ogImageUrl: site.seo.ogImageUrl,
      }),
    ],
    links: [{ rel: "canonical", href: canonical }],
    scripts: [jsonLdScript(buildRestaurantJsonLd(site, menuUrl))],
  };
}

/**
 * Online menu head: its own title/description (the home metadata describes the
 * cafe, not the menu), a canonical URL and the Menu JSON-LD.
 */
export function menuHead(
  site: PublicSite,
  page: PublicMenuPage,
  copy: { title: string; description: string; jsonLdName: string },
): SiteHead {
  const canonical = absoluteUrl(site.seo.canonicalUrl, "/menu");
  // A section with no items adds nothing for a crawler (and an empty Menu
  // JSON-LD is invalid), so the structured data lists populated sections only.
  const sections = page.sections.filter((section) => section.items.length > 0);
  return {
    meta: [
      { title: copy.title },
      { name: "description", content: copy.description },
      { name: "robots", content: site.seo.robots },
      ...socialMeta({
        title: copy.title,
        description: copy.description,
        url: canonical,
        siteName: site.brand.name,
        ogImageUrl: site.seo.ogImageUrl,
      }),
    ],
    links: [{ rel: "canonical", href: canonical }],
    scripts:
      sections.length > 0
        ? [
            jsonLdScript(
              buildMenuJsonLd({ ...page, sections }, copy.jsonLdName),
            ),
          ]
        : [],
  };
}

/** Reservation entry head: title/description from the catalog, no JSON-LD. */
export function reservationHead(
  site: PublicSite,
  copy: { title: string; description: string },
): SiteHead {
  const canonical = absoluteUrl(site.seo.canonicalUrl, "/reservation");
  return {
    meta: [
      { title: copy.title },
      { name: "description", content: copy.description },
      { name: "robots", content: site.seo.robots },
      ...socialMeta({
        title: copy.title,
        description: copy.description,
        url: canonical,
        siteName: site.brand.name,
        ogImageUrl: site.seo.ogImageUrl,
      }),
    ],
    links: [{ rel: "canonical", href: canonical }],
    scripts: [],
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * `/sitemap.xml` body for the brand site: home, online menu and reservation,
 * absolute from the canonical URL (contract `sitemapEntriesFor`). `/member` is
 * left out because it needs sign-in and robots.txt disallows it (PRD §5).
 */
export function sitemapXml(site: PublicSite): string {
  const entries: SitemapEntry[] = sitemapEntriesFor(site);
  const urls = entries
    .map((entry) =>
      [
        "  <url>",
        `    <loc>${escapeXml(entry.loc)}</loc>`,
        `    <lastmod>${escapeXml(entry.lastModified)}</lastmod>`,
        `    <changefreq>${entry.changeFrequency}</changefreq>`,
        `    <priority>${entry.priority.toFixed(1)}</priority>`,
        "  </url>",
      ].join("\n"),
    )
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    urls,
    "</urlset>",
    "",
  ].join("\n");
}

/**
 * `/robots.txt`: index the brand pages, keep the signed-in and operational
 * areas out (PRD §5 "Diindeks: Tidak"), and point crawlers at the sitemap.
 * Without a known canonical URL the Sitemap line is left out: the request's
 * Host header is client-controlled and must never end up in a cached file.
 */
export function robotsTxt(canonicalUrl: string | null): string {
  const disallow = [
    "/member",
    "/masuk",
    "/sign-in",
    "/sign-up",
    "/t/",
    "/f/",
    "/bayar",
    "/wifi",
    "/pos",
    "/fasilitas",
    "/operasional",
    "/kds",
    "/expo",
    "/pickup",
    "/kelola",
    "/owner",
    "/shareholder",
    "/karyawan",
    "/platform",
    "/design-system",
  ];
  return [
    "User-agent: *",
    "Allow: /",
    "",
    "# Signed-in and operational areas (PRD §5).",
    ...disallow.map((path) => `Disallow: ${path}`),
    "",
    ...(canonicalUrl
      ? [`Sitemap: ${new URL(canonicalUrl).origin}/sitemap.xml`, ""]
      : []),
  ].join("\n");
}
