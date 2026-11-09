import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/finance/supplier-due — generic report viewer for finance.supplier_due (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/finance/supplier-due")(
  reportRouteOptions("finance.supplier_due"),
);
