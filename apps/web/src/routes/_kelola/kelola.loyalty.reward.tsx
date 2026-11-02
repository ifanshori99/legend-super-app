import { createFileRoute } from "@tanstack/react-router";
import { LoyaltyPage } from "@/features/ws08-loyalty/components/loyalty-shell";
import { RewardsPage } from "@/features/ws08-loyalty/components/rewards-page";
import { loyaltyGuard } from "@/features/ws08-loyalty/guard";
import { isMockScenarioRequest } from "@/features/ws08-loyalty/lib";
import { rewardsQuery } from "@/features/ws08-loyalty/queries";

// /kelola/loyalty/reward — reward catalog with stock and validity
// (PRD §3.20 "Reward Katalog").
export const Route = createFileRoute("/_kelola/kelola/loyalty/reward")({
  beforeLoad: loyaltyGuard(["loyalty.program.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(rewardsQuery()),
  component: RewardsScreen,
});

function RewardsScreen() {
  return (
    <LoyaltyPage active="rewards">
      <RewardsPage />
    </LoyaltyPage>
  );
}
