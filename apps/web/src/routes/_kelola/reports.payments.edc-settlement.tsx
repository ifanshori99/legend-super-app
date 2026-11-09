import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payments/edc-settlement — generic report viewer for payments.edc_settlement (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/payments/edc-settlement",
)(reportRouteOptions("payments.edc_settlement"));
