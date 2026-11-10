import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/payments/gateway-settlement — generic report viewer for payments.gateway_settlement (PRD v1.7 §3 F36).
export const Route = createFileRoute(
  "/_kelola/reports/payments/gateway-settlement",
)(reportRouteOptions("payments.gateway_settlement"));
