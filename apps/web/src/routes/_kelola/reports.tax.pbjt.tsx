import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/tax/pbjt — generic report viewer for tax.pbjt (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/tax/pbjt")(
  reportRouteOptions("tax.pbjt"),
);
