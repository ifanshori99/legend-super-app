import { createFileRoute } from "@tanstack/react-router";
import { LoyaltyPage } from "@/features/ws08-loyalty/components/loyalty-shell";
import { ProgramPage } from "@/features/ws08-loyalty/components/program-page";
import { loyaltyGuard } from "@/features/ws08-loyalty/guard";
import { isMockScenarioRequest } from "@/features/ws08-loyalty/lib";
import { programQuery } from "@/features/ws08-loyalty/queries";

// /kelola/loyalty — the program: earn ratio, point value, expiry policy and
// the rolling tier window (PRD §3.20 "Poin", "Kedaluwarsa Poin", "Tier").
export const Route = createFileRoute("/_kelola/kelola/loyalty/")({
  beforeLoad: loyaltyGuard(["loyalty.program.manage"]),
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(programQuery()),
  component: ProgramScreen,
});

function ProgramScreen() {
  return (
    <LoyaltyPage active="program">
      <ProgramPage />
    </LoyaltyPage>
  );
}
