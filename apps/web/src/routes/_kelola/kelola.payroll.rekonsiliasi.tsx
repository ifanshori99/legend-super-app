import { createFileRoute } from "@tanstack/react-router";
import { ReconPage } from "@/features/ws10-payroll-payout/components/recon-page";
import { payoutAccess } from "@/features/ws10-payroll-payout/guard";
import { isMockScenarioRequest } from "@/features/ws10-payroll-payout/lib";
import { payoutReconFlagsQuery } from "@/features/ws10-payroll-payout/queries";
import { reconGuard } from "@/features/ws10-payroll-payout/recon-guard";

// /kelola/payroll/rekonsiliasi — recon flags of payout items and the
// two-person clearance. The shell owns the h1 ("Flag rekonsiliasi payout",
// the nav label).
export const Route = createFileRoute("/_kelola/kelola/payroll/rekonsiliasi")({
  beforeLoad: reconGuard,
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(payoutReconFlagsQuery()),
  component: ReconRoute,
});

function ReconRoute() {
  const { access, session } = Route.useRouteContext();
  return (
    <ReconPage
      access={payoutAccess(access)}
      currentUserId={session?.user.id ?? ""}
    />
  );
}
