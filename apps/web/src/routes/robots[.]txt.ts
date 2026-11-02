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
      GET: async ({ request }) => {
        let canonical = new URL(request.url).origin;
        try {
          const { data } = await callEndpoint(getPublicSite);
          canonical = data.seo.canonicalUrl;
        } catch {
          // Keep answering with the request's own origin: a 404 here hurts
          // indexing more than a slightly different Sitemap host.
        }
        return new Response(robotsTxt(canonical), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=300, s-maxage=3600",
          },
        });
      },
    },
  },
});
