import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { PayoutPage } from "@/features/ws10-payroll-payout/components/payout-page";
import {
  payoutAccess,
  payoutGuard,
} from "@/features/ws10-payroll-payout/guard";
import { isMockScenarioRequest } from "@/features/ws10-payroll-payout/lib";
import { legalEntitiesQuery } from "@/features/ws10-payroll-payout/queries";

// /kelola/payroll/pencairan — pay locked payroll runs by manual bank transfer
// with a two-person check (legend-wnkep.6, .7). The shell owns the h1.
const searchSchema = z.object({
  tab: z
    .enum(["runs", "approval", "status", "settings"])
    .catch("runs")
    .default("runs"),
  entity: z.string().optional().catch(undefined),
  batch: z.string().optional().catch(undefined),
});

export const Route = createFileRoute("/_kelola/kelola/payroll/pencairan")({
  beforeLoad: payoutGuard,
  validateSearch: searchSchema,
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(legalEntitiesQuery()),
  component: PayoutRoute,
});

function PayoutRoute() {
  const { access, session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <PayoutPage
      access={payoutAccess(access)}
      currentUserId={session?.user.id ?? ""}
      search={search}
      onSearchChange={(next) =>
        void navigate({
          search: next,
          // Switching tabs is not a history step worth keeping on every click.
          replace: false,
        })
      }
    />
  );
}
