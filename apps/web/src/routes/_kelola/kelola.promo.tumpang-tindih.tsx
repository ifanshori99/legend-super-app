import { createFileRoute } from "@tanstack/react-router";
import { StackingPage } from "@/features/ws08-promo/components/stacking-page";
import { PromoPage } from "@/features/ws08-promo/components/promo-shell";
import { promoGuard } from "@/features/ws08-promo/guard";
import { isMockScenarioRequest } from "@/features/ws08-promo/lib";
import { stackingPolicyQuery } from "@/features/ws08-promo/queries";

// /kelola/promo/tumpang-tindih — the tenant stacking policy and the sequential-percentage example (owner Q20).
export const Route = createFileRoute("/_kelola/kelola/promo/tumpang-tindih")({
  beforeLoad: promoGuard(["promo.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(stackingPolicyQuery()),
  component: StackingScreen,
});

function StackingScreen() {
  return (
    <PromoPage active="stacking">
      <StackingPage />
    </PromoPage>
  );
}
