import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payments/cash-variance — generic report viewer for payments.cash_variance (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payments/cash-variance")(
  reportRouteOptions("payments.cash_variance"),
);
