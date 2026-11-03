import { createFileRoute } from "@tanstack/react-router";
import { ServiceChargePage } from "@/features/ws10-payroll-run/components/service-charge-page";
import { serviceChargeGuard } from "@/features/ws10-payroll-run/guard";
import { isMockScenarioRequest } from "@/features/ws10-payroll-run/lib";
import { PAYROLL_OUTLET_ID } from "@/features/ws10-payroll-run/outlet";
import { poolsQuery } from "@/features/ws10-payroll-run/queries";

// /kelola/payroll/service-charge — service-charge pools and their split
// (PRD v1.7 §3 D.30 "Distribusi Service Charge", PAYR-04).
export const Route = createFileRoute("/_kelola/kelola/payroll/service-charge")({
  beforeLoad: serviceChargeGuard,
  loader: ({ context, location }) =>
    isMockScenarioRequest(location.searchStr)
      ? undefined
      : context.queryClient.ensureQueryData(poolsQuery(PAYROLL_OUTLET_ID)),
  component: ServiceChargeRoute,
});

function ServiceChargeRoute() {
  const { access } = Route.useRouteContext();
  return <ServiceChargePage access={access} />;
}
