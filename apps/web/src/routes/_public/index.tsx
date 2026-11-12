import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/features/ws08-website/components/home-page";
import {
  WebsiteError,
  WebsitePending,
} from "@/features/ws08-website/components/states";
import { usePublicSite } from "@/features/ws08-website/hooks";
import { loadWebsiteData } from "@/features/ws08-website/lib/loader";
import { absoluteUrl, homeHead } from "@/features/ws08-website/lib/seo";
import { publicSiteQuery } from "@/features/ws08-website/queries";

// "/" — brand home (PRD v1.7 §3.24 "Beranda"): cafe profile, photos, opening
// hours, location, featured menu and promos. SSR with the Restaurant JSON-LD in
// the head; the loader fills the query cache so the HTML already has content.
export const Route = createFileRoute("/_public/")({
  loader: ({ context }) =>
    loadWebsiteData(context.queryClient.ensureQueryData(publicSiteQuery())),
  head: ({ loaderData }) =>
    loaderData
      ? homeHead(loaderData, absoluteUrl(loaderData.seo.canonicalUrl, "/menu"))
      : {},
  pendingComponent: WebsitePending,
  errorComponent: WebsiteError,
  component: Home,
});

function Home() {
  const site = usePublicSite();
  const { session } = Route.useRouteContext();
  return <HomePage site={site} signedIn={session !== null} />;
}
