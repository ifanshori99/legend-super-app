import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payments/failed — generic report viewer for payments.failed (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/payments/failed")(
  reportRouteOptions("payments.failed"),
);
