import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/tax/service-charge — generic report viewer for tax.service_charge (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/tax/service-charge")(
  reportRouteOptions("tax.service_charge"),
);
