// "/reservasi" — the guest booking flow (bead legend-xm4y; PRD v1.7 §3.22
// "Reservasi & Event", §4 Alur H steps 1–4, RSV-02/RSV-03). The route owns the
// deep-linked mode (`?mode=antre` opens the walk-in waitlist), the site payload
// for server rendering, and the SEO head; the page owns the flow itself.
//
// The canonical link stays the contract's `/reservation` route
// (PUBLIC_SITE_ROUTES.reservation): the brand site's reservation entry page
// carries the primary CTA into this form, so search engines see one page.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { ReservasiPage } from "@/features/ws08-reservation-customer/components/reservasi-page";
import {
  WebsiteError,
  WebsitePending,
} from "@/features/ws08-website/components/states";
import { usePublicSite } from "@/features/ws08-website/hooks";
import { loadWebsiteData } from "@/features/ws08-website/lib/loader";
import { reservationHead } from "@/features/ws08-website/lib/seo";
import { publicSiteQuery } from "@/features/ws08-website/queries";

const t = createTranslator();

/** Deep link: booking (default) or the walk-in waitlist. */
const searchSchema = z.object({
  mode: z.enum(["booking", "antre"]).optional().catch(undefined),
});

export const Route = createFileRoute("/_public/reservasi")({
  validateSearch: searchSchema,
  loader: ({ context }) =>
    loadWebsiteData(context.queryClient.ensureQueryData(publicSiteQuery())),
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const brand = loaderData.brand.name;
    return reservationHead(loaderData, {
      title: t("reservationBooking.seo.title", { brand }),
      description: t("reservationBooking.seo.description", { brand }),
    });
  },
  pendingComponent: WebsitePending,
  errorComponent: WebsiteError,
  component: ReservasiRoute,
});

function ReservasiRoute() {
  const site = usePublicSite();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ReservasiPage
      site={site}
      signedIn={session !== null}
      mode={search.mode ?? "booking"}
      onModeChange={(mode) =>
        void navigate({ search: (previous) => ({ ...previous, mode }) })
      }
    />
  );
}
