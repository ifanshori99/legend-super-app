import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/tax/receivable — generic report viewer for tax.receivable (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/tax/receivable")(
  reportRouteOptions("tax.receivable"),
);
