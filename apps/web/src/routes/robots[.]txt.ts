// /robots.txt — crawler rules for the brand site (PRD v1.7 §3.24 "SEO Lokal",
// §5 "Diindeks: Tidak"): brand pages are open, signed-in and operational areas
// are not, and the sitemap is advertised. A server route, so the file is served
// before any React render.
import { createFileRoute } from "@tanstack/react-router";
import { getPublicSite } from "@starter/shared/website";
import { callEndpoint } from "@/lib/api/endpoint";
import { robotsTxt } from "@/features/ws08-website/lib/seo";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: async () => {
        let canonical: string | null = null;
        try {
          const { data } = await callEndpoint(getPublicSite);
          canonical = data.seo.canonicalUrl;
        } catch {
          // The API is unreachable: still answer the crawl rules, but without
          // a Sitemap line — the request's Host header is client-controlled and
          // must not be written into a publicly cached file. Cache briefly so
          // the full file returns once the API is back.
        }
        return new Response(robotsTxt(canonical), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": canonical
              ? "public, max-age=300, s-maxage=3600"
              : "public, max-age=60, s-maxage=60",
          },
        });
      },
    },
  },
});
