import { createFileRoute } from "@tanstack/react-router";
import { RoiPage } from "@/features/ws08-promo/components/roi-page";
import { PromoPage } from "@/features/ws08-promo/components/promo-shell";
import { promoGuard } from "@/features/ws08-promo/guard";
import { isMockScenarioRequest } from "@/features/ws08-promo/lib";
import { promotionsQuery } from "@/features/ws08-promo/queries";

// /kelola/promo/roi — discount cost, revenue and net margin per promotion (PRD §3.21 "ROI Promo").
export const Route = createFileRoute("/_kelola/kelola/promo/roi")({
  beforeLoad: promoGuard(["promo.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(promotionsQuery()),
  component: RoiScreen,
});

function RoiScreen() {
  return (
    <PromoPage active="roi">
      <RoiPage />
    </PromoPage>
  );
}
