import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { OwnerDashboardPage } from "@/features/ws11-owner-dashboard/components/dashboard-page";
import { ownerDashboardQuery } from "@/features/ws11-owner-dashboard/queries";

const t = createTranslator();

// Owner · Dashboard (PRD v1.7 §3 F34, DASH-01/DASH-03). The area layout
// already enforces dashboard.owner.view + MFA; the loader carries the layout
// (GET) through SSR, while tile values run as source reports after hydration.
export const Route = createFileRoute("/_owner/owner/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(ownerDashboardQuery()),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("ownerDashboard.title"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: OwnerDashboardPage,
});
