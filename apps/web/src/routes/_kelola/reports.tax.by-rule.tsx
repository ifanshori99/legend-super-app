import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/tax/by-rule — generic report viewer for tax.by_rule (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/tax/by-rule")(
  reportRouteOptions("tax.by_rule"),
);
