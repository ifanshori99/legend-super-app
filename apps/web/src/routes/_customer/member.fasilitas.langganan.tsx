import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { createTranslator } from "@starter/shared/i18n";
import { FacilitySubscriptionScreen } from "@/features/facility/components/subscription-screen";
import {
  currentSubscriptionQuery,
  subscriptionPlansQuery,
} from "@/features/facility/queries";

// "/member/fasilitas/langganan" — plans, current quota, invoices and
// pause/stop (PRD §3 F22 "Langganan Bulanan", alur U).
//
// `?facility=` only matters when the guest has no subscription yet and wants to
// choose a plan: the contract has no "list my facilities" read, so Fasilitas
// Saya passes the facility it already knows (follow-up bead).
const t = createTranslator();

const searchSchema = z.object({
  facility: z.string().uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_customer/member/fasilitas/langganan")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("facility.subscription.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  loaderDeps: ({ search }) => ({ facility: search.facility }),
  // Prefetch for the first paint; a failure is left in the cache for the
  // screen's own ErrorState instead of blanking the route.
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient
        .ensureQueryData(currentSubscriptionQuery())
        .catch(() => undefined),
      deps.facility
        ? context.queryClient
            .ensureQueryData(subscriptionPlansQuery(deps.facility))
            .catch(() => undefined)
        : Promise.resolve(undefined),
    ]),
  component: SubscriptionPage,
});

function SubscriptionPage() {
  const { facility } = Route.useSearch();
  return <FacilitySubscriptionScreen facilityFromSearch={facility} />;
}
