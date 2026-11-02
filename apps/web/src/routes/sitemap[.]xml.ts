// /sitemap.xml — the brand site's sitemap (PRD v1.7 §3.24 "SEO Lokal": sitemap).
// A server route, not a page: it answers XML from the website contract and the
// same `sitemapEntriesFor` the contract tests cover. Public and cacheable — it
// carries no visitor data.
import { createFileRoute } from "@tanstack/react-router";
import { getPublicSite } from "@starter/shared/website";
import { callEndpoint } from "@/lib/api/endpoint";
import { sitemapXml } from "@/features/ws08-website/lib/seo";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const { data } = await callEndpoint(getPublicSite);
          return new Response(sitemapXml(data), {
            headers: {
              "content-type": "application/xml; charset=utf-8",
              "cache-control": "public, max-age=300, s-maxage=3600",
            },
          });
        } catch {
          // The API is unreachable: tell crawlers to come back instead of
          // serving an empty sitemap (an empty one de-indexes the site).
          return new Response(null, {
            status: 503,
            headers: { "retry-after": "300" },
          });
        }
      },
    },
  },
});
