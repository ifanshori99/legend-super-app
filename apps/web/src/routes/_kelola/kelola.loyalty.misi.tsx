import { createFileRoute } from "@tanstack/react-router";
import { LoyaltyPage } from "@/features/ws08-loyalty/components/loyalty-shell";
import { MissionsPage } from "@/features/ws08-loyalty/components/missions-page";
import { loyaltyGuard } from "@/features/ws08-loyalty/guard";
import { isMockScenarioRequest } from "@/features/ws08-loyalty/lib";
import { missionsQuery } from "@/features/ws08-loyalty/queries";

// /kelola/loyalty/misi — missions and digital stamp cards (PRD §3.20
// "Mission").
export const Route = createFileRoute("/_kelola/kelola/loyalty/misi")({
  beforeLoad: loyaltyGuard(["loyalty.program.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(missionsQuery()),
  component: MissionsScreen,
});

function MissionsScreen() {
  return (
    <LoyaltyPage active="missions">
      <MissionsPage />
    </LoyaltyPage>
  );
}
