import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payments/methods — generic report viewer for payments.methods (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payments/methods")(
  reportRouteOptions("payments.methods"),
);
