import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ReservationPage } from "@/features/ws08-website/components/reservation-page";
import {
  WebsiteError,
  WebsitePending,
} from "@/features/ws08-website/components/states";
import { usePublicSite } from "@/features/ws08-website/hooks";
import { reservationHead } from "@/features/ws08-website/lib/seo";
import { publicSiteQuery } from "@/features/ws08-website/queries";

const t = createTranslator();

// "/reservation" — reservation and member entry (PRD v1.7 §3.24 "Reservasi &
// Member"). The canonical path matches the website contract's sitemap entry
// (PUBLIC_SITE_ROUTES.reservation); the full booking flow with availability and
// DP lives at /reservasi (bead legend-xm4y).
export const Route = createFileRoute("/_public/reservation")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(publicSiteQuery()),
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const brand = loaderData.brand.name;
    return reservationHead(loaderData, {
      title: t("website.seo.reservationTitle", { brand }),
      description: t("website.seo.reservationDescription", { brand }),
    });
  },
  pendingComponent: WebsitePending,
  errorComponent: WebsiteError,
  component: Reservation,
});

function Reservation() {
  const site = usePublicSite();
  const { session } = Route.useRouteContext();
  return <ReservationPage site={site} signedIn={session !== null} />;
}
