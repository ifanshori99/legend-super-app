import { createFileRoute } from "@tanstack/react-router";
import { ServiceChargePage } from "@/features/ws10-payroll-run/components/service-charge-page";
import { serviceChargeGuard } from "@/features/ws10-payroll-run/guard";

// /kelola/payroll/service-charge — service-charge pools and their split
// (PRD v1.7 §3 D.30 "Distribusi Service Charge", PAYR-04).
export const Route = createFileRoute("/_kelola/kelola/payroll/service-charge")({
  beforeLoad: serviceChargeGuard,
  // Outlet-scoped data loads in the screen, once the shell has chosen the outlet.
  component: ServiceChargeRoute,
});

function ServiceChargeRoute() {
  const { access } = Route.useRouteContext();
  return <ServiceChargePage access={access} />;
}
