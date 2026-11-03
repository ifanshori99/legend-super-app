import { createFileRoute } from "@tanstack/react-router";
import { createTranslator } from "@starter/shared/i18n";
import { ShareholderDashboardPage } from "@/features/ws11-shareholder/components/shareholder-page";
import { shareholderDashboardQuery } from "@/features/ws11-shareholder/queries";

const t = createTranslator();

// Shareholder · Dashboard (PRD v1.7 §3 F35, §4 Alur O; SH-01, SH-02, DASH-03).
// The area layout already enforces dashboard.shareholder.view + MFA; the loader
// carries the layout (GET) through SSR, while report runs and the personal
// profit-share data load after hydration.
export const Route = createFileRoute("/_shareholder/shareholder/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(shareholderDashboardQuery()),
  head: () => ({
    meta: [
      {
        title: t("app.titleTemplate", {
          page: t("shareholderHome.title"),
          brand: t("app.defaultBrand"),
        }),
      },
    ],
  }),
  component: ShareholderRoute,
});

function ShareholderRoute() {
  const { access } = Route.useRouteContext();
  return <ShareholderDashboardPage permissions={access.permissions} />;
}
