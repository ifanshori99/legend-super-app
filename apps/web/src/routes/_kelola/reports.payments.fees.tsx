import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payments/fees — generic report viewer for payments.fees (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payments/fees")(
  reportRouteOptions("payments.fees"),
);
