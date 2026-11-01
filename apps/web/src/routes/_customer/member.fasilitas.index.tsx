import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { FacilityListScreen } from "@/features/facility/components/list-screen";
import { currentSubscriptionQuery } from "@/features/facility/queries";
import { ticketsQuery } from "@/features/facility/queries";

// "/member/fasilitas" — Fasilitas Saya: the guest's tickets and subscription
// (PRD §3 F22, alur T langkah 3 "Fasilitas Saya"). Signed-in customers only;
// the `_customer/member` layout enforces the session.
const t = createTranslator();

export const Route = createFileRoute("/_customer/member/fasilitas/")({
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("facility.list.title"),
          brand: t("app.defaultBrand"),
        }),
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  // Server-render the list from the visitor's own data (mock mode: fixtures).
  // A rejected prefetch stays in the query cache as an error and the screen
  // renders its own ErrorState with a retry, so one failing read does not blank
  // the page.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient
        .ensureQueryData(ticketsQuery())
        .catch(() => undefined),
      context.queryClient
        .ensureQueryData(currentSubscriptionQuery())
        .catch(() => undefined),
    ]),
  component: FacilityListScreen,
});
