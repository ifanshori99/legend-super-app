import { createFileRoute } from "@tanstack/react-router";
import { PromoListPage } from "@/features/ws08-promo/components/promo-list-page";
import { PromoPage } from "@/features/ws08-promo/components/promo-shell";
import { promoGuard } from "@/features/ws08-promo/guard";
import { isMockScenarioRequest } from "@/features/ws08-promo/lib";
import { promotionsQuery } from "@/features/ws08-promo/queries";

// /kelola/promo — the promotion list: status filter, benefit in words, validity, quota and budget (PRD §3.21).
export const Route = createFileRoute("/_kelola/kelola/promo/")({
  beforeLoad: promoGuard(["promo.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(promotionsQuery()),
  component: PromoListScreen,
});

function PromoListScreen() {
  return (
    <PromoPage active="promos">
      <PromoListPage />
    </PromoPage>
  );
}
