// /manifest.webmanifest — the installable web manifest (PRD §5: the per-brand
// manifest is generated from the tenant, TEN-08). A server route, not a static
// file: the tenant comes from the host name, so the name shown on the home
// screen is the brand's, never the platform's. With the API unreachable it
// answers the catalog fallback brand and a short cache, never the platform name.
import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { getPublicSite } from "@starter/shared/website";
import { callEndpoint } from "@/lib/api/endpoint";
import { manifestFor } from "@/features/ws08-website/lib/manifest";

export const Route = createFileRoute("/manifest.webmanifest")({
  server: {
    handlers: {
      GET: async () => {
        let brandName: string | null = null;
        try {
          const { data } = await callEndpoint(getPublicSite);
          brandName = data.brand.name;
        } catch {
          // Fall through to the catalog brand below.
        }
        return new Response(
          JSON.stringify(
            manifestFor(brandName ?? createTranslator()("app.defaultBrand")),
          ),
          {
            headers: {
              "content-type": "application/manifest+json; charset=utf-8",
              "cache-control": brandName
                ? "public, max-age=300, s-maxage=3600"
                : "public, max-age=60, s-maxage=60",
            },
          },
        );
      },
    },
  },
});
