import { createFileRoute } from "@tanstack/react-router";
import { reportRouteOptions } from "@/features/ws11-reports/route-options";

// /reports/delivery/settlement — generic report viewer for delivery.settlement (PRD v1.7 §3 F36).
export const Route = createFileRoute("/_kelola/reports/delivery/settlement")(
  reportRouteOptions("delivery.settlement"),
);
