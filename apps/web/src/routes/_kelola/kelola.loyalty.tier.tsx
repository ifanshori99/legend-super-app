import { createFileRoute } from "@tanstack/react-router";
import { LoyaltyPage } from "@/features/ws08-loyalty/components/loyalty-shell";
import { TiersPage } from "@/features/ws08-loyalty/components/tiers-page";
import { loyaltyGuard } from "@/features/ws08-loyalty/guard";
import { isMockScenarioRequest } from "@/features/ws08-loyalty/lib";
import { tiersQuery } from "@/features/ws08-loyalty/queries";

// /kelola/loyalty/tier — tiers and benefits (PRD §3.20 "Tier").
export const Route = createFileRoute("/_kelola/kelola/loyalty/tier")({
  beforeLoad: loyaltyGuard(["loyalty.program.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(tiersQuery()),
  component: TiersScreen,
});

function TiersScreen() {
  return (
    <LoyaltyPage active="tiers">
      <TiersPage />
    </LoyaltyPage>
  );
}
